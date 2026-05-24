"""ContextoEngine — Hermes ContextEngine ABC implementation.

Compaction lives in `compress()`: ingest drop slice → search → inject as
synthetic user+assistant pair → token-invariant guard. See spec §6.

Note: `agent.context_engine` is imported lazily inside the class body. The
hermes-agent plugin loader exec's the plugin module before the agent module
path is fully set up.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from .client import RemoteBackend
from .helpers import (
    build_episode_payload,
    format_search_results,
    normalize_message_text,
    strip_metadata_envelope,
)
from .tools import CONTEXTO_SEARCH_SCHEMA, contexto_search
from .types import ApiError, ContextoConfig, WebhookPayload

logger = logging.getLogger("plugins.context_engine.contexto")

_RECALL_LEAD_IN = "[Recalled context from previous conversations]"


def _coerce_token(value: Any, fallback: int) -> int:
    """Coerce a provider-reported token count to int, never raising.

    Handles ints, floats, and numeric strings (including "1.5"). On anything
    non-numeric, returns the prior value so a malformed usage dict is a no-op
    rather than a crash.
    """
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        try:
            return int(float(value))
        except (TypeError, ValueError):
            return fallback


def _load_base():
    """Return Hermes' ContextEngine ABC, or a minimal stub when running outside Hermes.

    The stub preserves the same class attributes (`last_prompt_tokens`,
    `threshold_tokens`, etc.) Hermes' run_agent.py and gateway read directly.
    Used so `python -m contexto_hermes.install` works without hermes-agent on
    sys.path.
    """
    try:
        from agent.context_engine import ContextEngine  # type: ignore[import-not-found]
        return ContextEngine
    except ModuleNotFoundError:
        class _StubContextEngine:
            last_prompt_tokens: int = 0
            last_completion_tokens: int = 0
            last_total_tokens: int = 0
            threshold_tokens: int = 0
            context_length: int = 0
            compression_count: int = 0
            threshold_percent: float = 0.75
            protect_first_n: int = 3
            protect_last_n: int = 6

            def on_session_reset(self) -> None:
                self.last_prompt_tokens = 0
                self.last_completion_tokens = 0
                self.last_total_tokens = 0
                self.compression_count = 0

            def update_model(
                self,
                model: str,
                context_length: int,
                base_url: str = "",
                api_key: str = "",
                provider: str = "",
            ) -> None:
                self.context_length = context_length
                self.threshold_tokens = int(context_length * self.threshold_percent)

            def get_status(self) -> dict:
                return {
                    "last_prompt_tokens": self.last_prompt_tokens,
                    "threshold_tokens": self.threshold_tokens,
                    "context_length": self.context_length,
                    "usage_percent": (
                        min(100, self.last_prompt_tokens / self.context_length * 100)
                        if self.context_length else 0
                    ),
                    "compression_count": self.compression_count,
                }

        return _StubContextEngine


class ContextoEngine(_load_base()):  # type: ignore[misc]
    """Contexto context engine. Implements the Hermes ABC.

    Internal state:
      - `session_id`: also used as `sessionKey` in payloads.
      - `model` / `provider`: set by `update_model`; used in episode runtime_context.
      - `injected_item_ids`: dedup across compactions and tool calls.
      - `auth_state`: "ok" | "degraded" | "auth_error"
      - `last_api_error`: human-readable last error string.
      - `consecutive_ingest_failures`: fail-closed compaction counter.
      - `last_ingest_failure`: last fail-closed ingest reason.
    """

    @classmethod
    def from_env(cls) -> "ContextoEngine | None":
        """Read CONTEXTO_* env vars. Returns None iff CONTEXTO_API_KEY is unset."""
        config = ContextoConfig.from_env()
        if config is None:
            return None
        return cls(config)

    def __init__(self, config: ContextoConfig, backend: Any | None = None) -> None:
        super().__init__()
        self.config = config
        self.session_id: str = ""
        self.model: str | None = None
        self.provider: str | None = None
        self.injected_item_ids: set[str] = set()
        self.auth_state: str = "ok"
        self.last_api_error: str | None = None
        self.consecutive_ingest_failures: int = 0
        self.last_ingest_failure: str | None = None
        if backend is None:
            backend = RemoteBackend(
                config,
                on_error=self._on_backend_error,
                on_success=self._on_backend_success,
            )
        self.client = backend

    # ------------------------------------------------------------------ identity
    @property
    def name(self) -> str:
        return "contexto"

    # --------------------------------------------------------- token / model
    def update_from_response(self, usage: dict[str, Any]) -> None:
        if not isinstance(usage, dict):
            return
        # Token counts come from upstream provider responses; some OpenAI-compatible
        # providers emit them as strings (e.g. "1234") or omit/garble them. Coerce
        # defensively so a malformed usage dict never crashes Hermes' response path.
        if "prompt_tokens" in usage:
            self.last_prompt_tokens = _coerce_token(usage["prompt_tokens"], self.last_prompt_tokens)
        if "completion_tokens" in usage:
            self.last_completion_tokens = _coerce_token(
                usage["completion_tokens"], self.last_completion_tokens
            )
        if "total_tokens" in usage:
            self.last_total_tokens = _coerce_token(usage["total_tokens"], self.last_total_tokens)

    def update_model(
        self,
        model: str,
        context_length: int,
        base_url: str = "",
        api_key: str = "",
        provider: str = "",
        **_kwargs: Any,
    ) -> None:
        # Accept and ignore unknown kwargs (e.g. `api_mode` from Hermes'
        # run_agent.py / agent_runtime_helpers.py). Hermes may add more in
        # future versions; we must never break model switching.
        super().update_model(model, context_length, base_url, api_key, provider)
        self.model = model or None
        self.provider = provider or None

    def should_compress(self, prompt_tokens: int | None = None) -> bool:
        if not self.context_length:
            return False
        tokens = prompt_tokens if prompt_tokens is not None else self.last_prompt_tokens
        return (tokens / self.context_length) >= self.threshold_percent

    def should_compress_preflight(self, messages: list[dict[str, Any]]) -> bool:
        """Cheap fallback when a provider path has not reported prompt_tokens yet."""
        if not self.context_length or not self.has_content_to_compress(messages):
            return False
        return (self._estimate_tokens(messages) / self.context_length) >= self.threshold_percent

    def has_content_to_compress(self, messages: list[dict[str, Any]]) -> bool:
        non_system = [m for m in messages if m.get("role") != "system"]
        return len(non_system) > self.protect_first_n + self.protect_last_n

    # ----------------------------------------------------------- lifecycle
    def on_session_start(self, session_id: str, **kwargs: Any) -> None:
        self.session_id = session_id if session_id else f"contexto-{uuid.uuid4().hex}"

    def on_session_end(self, session_id: str, messages: list[dict[str, Any]]) -> None:
        # Per-request httpx.Client; nothing to close.
        return

    def on_session_reset(self) -> None:
        super().on_session_reset()
        self.injected_item_ids.clear()
        # session_id intentionally preserved (matches ContextCompressor pattern).

    # ----------------------------------------------------------------- tools
    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return [CONTEXTO_SEARCH_SCHEMA]

    def handle_tool_call(self, name: str, args: dict[str, Any], **kwargs: Any) -> str:
        import json
        if name != CONTEXTO_SEARCH_SCHEMA["name"]:
            return json.dumps({"error": f"Unknown context engine tool: {name}"})
        return contexto_search(self, args)

    # ---------------------------------------------------------------- status
    def get_status(self) -> dict[str, Any]:
        status = super().get_status()
        status["auth_state"] = self.auth_state
        status["last_api_error"] = self.last_api_error
        status["consecutive_ingest_failures"] = self.consecutive_ingest_failures
        status["last_ingest_failure"] = self.last_ingest_failure
        return status

    # -------------------------------------------------- backend observers
    def _on_backend_error(self, err: ApiError) -> None:
        self.last_api_error = f"{err.category}: {err.message}"
        if err.category == "auth":
            self._set_auth_state("auth_error", reason=err.message)
        elif self.auth_state != "auth_error":
            # All other failure modes degrade the engine, but never override auth_error.
            self._set_auth_state("degraded", reason=f"{err.category} {err.message}")

    def _on_backend_success(self) -> None:
        if self.auth_state != "ok":
            self._set_auth_state("ok", reason="successful API call")

    def _set_auth_state(self, new_state: str, *, reason: str) -> None:
        if self.auth_state == new_state:
            return
        prev = self.auth_state
        self.auth_state = new_state
        logger.info(
            "[contexto] auth_state: %s → %s (%s)", prev, new_state, reason,
        )

    # ----------------------------------------------------------- compaction
    def compress(
        self,
        messages: list[dict[str, Any]],
        current_tokens: int | None = None,
        focus_topic: str | None = None,
    ) -> list[dict[str, Any]]:
        """Compact messages per spec §6."""
        # Step 1 — Split
        system_messages = [m for m in messages if m.get("role") == "system"]
        non_system = [m for m in messages if m.get("role") != "system"]

        if len(non_system) <= self.protect_first_n + self.protect_last_n:
            return messages

        head = non_system[: self.protect_first_n]
        tail = (
            non_system[-self.protect_last_n :]
            if self.protect_last_n > 0
            else []
        )
        drop_slice = non_system[self.protect_first_n : len(non_system) - self.protect_last_n]

        if not drop_slice:
            return messages

        # Step 2 — Ingest drop slice (always, even when context_enabled=False)
        payload: WebhookPayload = build_episode_payload(
            messages=drop_slice,
            session_id=self.session_id,
            session_key=self.session_id,
            runtime_context={"model": self.model, "provider": self.provider},
        )
        previous_api_error = self.last_api_error
        ingest_ok = self.client.ingest([payload])
        if not ingest_ok:
            self._record_ingest_failure(previous_api_error)
            return messages
        self._record_ingest_success()

        head_and_tail = system_messages + head + tail
        self.compression_count += 1

        # Step 3 — Retrieve + assemble
        if not self.config.context_enabled:
            return head_and_tail

        # Step 4a — Message-count gate: only inject pair when drop_slice has >= 3 messages
        if len(drop_slice) < 3:
            return head_and_tail

        query = self._select_query(tail, focus_topic)
        if not query:
            return head_and_tail

        result = self.client.search(
            query,
            max_results=self.config.max_results,
            filter={"source": "summary"},
            min_score=self.config.min_score,
        )
        if result is None:
            return head_and_tail

        filtered_items = [
            entry for entry in result.items
            if (item_id := self._entry_id(entry)) is None or item_id not in self.injected_item_ids
        ]
        if not filtered_items:
            return head_and_tail

        context_block = format_search_results(filtered_items)
        if self.config.max_context_chars > 0 and len(context_block) > self.config.max_context_chars:
            context_block = context_block[: self.config.max_context_chars] + "…"

        retrieved_pair = [
            {"role": "user", "content": [{"type": "text", "text": _RECALL_LEAD_IN}]},
            {"role": "assistant", "content": [{"type": "text", "text": context_block}]},
        ]
        candidate = system_messages + head + retrieved_pair + tail

        # Step 4b — Token-invariant check
        if self._estimate_tokens(candidate) >= self._estimate_tokens(messages):
            return head_and_tail

        # Survives both checks — record dedup ids
        for entry in filtered_items:
            item_id = self._entry_id(entry)
            if item_id is not None:
                self.injected_item_ids.add(item_id)

        return candidate

    # -------------------------------------------------------- internals
    def _select_query(
        self,
        tail: list[dict[str, Any]],
        focus_topic: str | None,
    ) -> str:
        if focus_topic:
            return focus_topic.strip()
        # Per spec §6 Step 3: use the LAST user-role message in the tail.
        # If that specific message has no usable text, skip Step 3 entirely —
        # don't fall back to earlier user messages.
        for msg in reversed(tail):
            if msg.get("role") == "user":
                return strip_metadata_envelope(normalize_message_text(msg))
        return ""

    @staticmethod
    def _entry_id(entry: Any) -> str | None:
        if not isinstance(entry, dict):
            return None
        if "item" in entry and isinstance(entry["item"], dict):
            return entry["item"].get("id")
        return entry.get("id")

    def _record_ingest_failure(self, previous_api_error: str | None) -> None:
        self.consecutive_ingest_failures += 1
        self.last_ingest_failure = self.last_api_error or "ingest returned False"
        msg = (
            "[contexto] ingest failed; preserving original messages "
            "(consecutive failures: %d, reason: %s)"
        )
        args = (self.consecutive_ingest_failures, self.last_ingest_failure)
        # If the backend already emitted a concrete error for this call, avoid
        # a second warning. If it returned False silently (for example during
        # rate-limit suppression), keep one visible engine-boundary signal.
        if self.last_api_error != previous_api_error:
            logger.debug(msg, *args)
        else:
            logger.warning(msg, *args)

    def _record_ingest_success(self) -> None:
        self.consecutive_ingest_failures = 0
        self.last_ingest_failure = None

    def _estimate_tokens(self, messages: list[dict[str, Any]]) -> int:
        text_buffer: list[str] = []
        for msg in messages:
            text_buffer.append(normalize_message_text(msg))
        text = "\n".join(text_buffer)
        if self.model and self.model.startswith("gpt-"):
            try:
                import tiktoken
                enc = tiktoken.encoding_for_model(self.model)
                return len(enc.encode(text))
            except Exception:
                pass
        return max(1, len(text) // 4)
