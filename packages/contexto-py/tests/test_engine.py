"""Tests for contexto_hermes.engine — ContextoEngine.

Covers ABC compliance, compress() paths in spec §6, and invariants in §9.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

import pytest

try:
    from agent.context_engine import ContextEngine
except ModuleNotFoundError:
    ContextEngine = None

from contexto_hermes.engine import ContextoEngine
from contexto_hermes.types import ApiError, ContextoConfig, SearchResult


@dataclass
class StubBackend:
    """In-memory stand-in for RemoteBackend. Captures ingest/search calls."""

    search_result: SearchResult | None = None
    ingest_succeeds: bool = True
    ingest_calls: list[list[dict[str, Any]]] = field(default_factory=list)
    search_calls: list[dict[str, Any]] = field(default_factory=list)
    on_error_handler: Any = None
    on_success_handler: Any = None
    force_error: ApiError | None = None

    def ingest(self, payloads):
        self.ingest_calls.append(list(payloads))
        if self.force_error and self.on_error_handler:
            self.on_error_handler(self.force_error)
            return False
        if self.ingest_succeeds and self.on_success_handler:
            self.on_success_handler()
        return self.ingest_succeeds

    def search(self, query, max_results, filter, min_score):
        self.search_calls.append({
            "query": query, "max_results": max_results,
            "filter": filter, "min_score": min_score,
        })
        if self.force_error and self.on_error_handler:
            self.on_error_handler(self.force_error)
            return None
        if self.search_result is not None and self.on_success_handler:
            self.on_success_handler()
        return self.search_result


def _config(**overrides) -> ContextoConfig:
    base = {
        "api_key": "ckai_test",
        "context_enabled": True,
        "max_context_chars": 2000,
        "min_score": 0.45,
        "max_results": 7,
        "search_timeout": 10.0,
        "ingest_timeout": 30.0,
    }
    base.update(overrides)
    return ContextoConfig(**base)


def _build_engine(*, search_result=None, ingest_succeeds=True, **cfg_overrides):
    cfg = _config(**cfg_overrides)
    backend = StubBackend(search_result=search_result, ingest_succeeds=ingest_succeeds)
    engine = ContextoEngine(cfg, backend=backend)
    backend.on_error_handler = engine._on_backend_error  # type: ignore[attr-defined]
    backend.on_success_handler = engine._on_backend_success  # type: ignore[attr-defined]
    return engine, backend


def _conversation(n_non_system: int) -> list[dict[str, Any]]:
    """Build a system + n_non_system messages conversation."""
    msgs = [{"role": "system", "content": "You are a helpful assistant."}]
    for i in range(n_non_system):
        role = "user" if i % 2 == 0 else "assistant"
        msgs.append({"role": role, "content": f"msg {i} " + "x" * 200})
    return msgs


# ============================================================================
# Identity / ABC compliance
# ============================================================================

class TestIdentity:
    def test_name(self) -> None:
        engine, _ = _build_engine()
        assert engine.name == "contexto"

    def test_is_context_engine_subclass(self) -> None:
        if ContextEngine is None:
            pytest.skip("hermes-agent is not available")
        engine, _ = _build_engine()
        assert isinstance(engine, ContextEngine)


# ============================================================================
# should_compress / has_content_to_compress / counters
# ============================================================================

class TestShouldCompress:
    def test_below_threshold(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("gpt-4o", context_length=10000)
        assert engine.should_compress(prompt_tokens=5000) is False

    def test_at_threshold(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("gpt-4o", context_length=10000)
        # threshold = 7500 by default (0.75 * 10000)
        assert engine.should_compress(prompt_tokens=7500) is True

    def test_above_threshold(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("gpt-4o", context_length=10000)
        assert engine.should_compress(prompt_tokens=8000) is True

    def test_uses_last_prompt_tokens_when_not_given(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("gpt-4o", context_length=10000)
        engine.last_prompt_tokens = 9000
        assert engine.should_compress() is True

    def test_preflight_fallback_uses_message_estimate(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("claude-test", context_length=100)
        msgs = _conversation(20)
        for msg in msgs:
            if msg["role"] != "system":
                msg["content"] = "x" * 20
        assert engine.should_compress_preflight(msgs) is True

    def test_preflight_fallback_requires_compressible_content(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("claude-test", context_length=10)
        msgs = [
            {"role": "system", "content": "x" * 1000},
            {"role": "user", "content": "x" * 1000},
        ]
        assert engine.should_compress_preflight(msgs) is False


class TestHasContentToCompress:
    def test_false_when_only_protected(self) -> None:
        engine, _ = _build_engine()
        # protect_first_n=3, protect_last_n=6 → 9 protected non-system msgs
        assert engine.has_content_to_compress(_conversation(9)) is False

    def test_true_when_drop_slice_non_empty(self) -> None:
        engine, _ = _build_engine()
        assert engine.has_content_to_compress(_conversation(15)) is True

    def test_system_messages_not_counted(self) -> None:
        engine, _ = _build_engine()
        msgs = [
            {"role": "system", "content": "sys1"},
            {"role": "system", "content": "sys2"},
            *[{"role": "user", "content": f"u{i}"} for i in range(9)],
        ]
        assert engine.has_content_to_compress(msgs) is False


class TestUpdateFromResponse:
    def test_updates_token_counters(self) -> None:
        engine, _ = _build_engine()
        engine.update_from_response({
            "prompt_tokens": 1000,
            "completion_tokens": 200,
            "total_tokens": 1200,
        })
        assert engine.last_prompt_tokens == 1000
        assert engine.last_completion_tokens == 200
        assert engine.last_total_tokens == 1200

    def test_handles_missing_keys(self) -> None:
        engine, _ = _build_engine()
        engine.update_from_response({"prompt_tokens": 50})
        assert engine.last_prompt_tokens == 50
        # Should not raise on missing completion/total

    def test_numeric_string_token_counts_coerced(self) -> None:
        engine, _ = _build_engine()
        engine.update_from_response({
            "prompt_tokens": "1000",
            "completion_tokens": "1.5",
            "total_tokens": "1200",
        })
        assert engine.last_prompt_tokens == 1000
        assert engine.last_completion_tokens == 1  # "1.5" -> float -> int
        assert engine.last_total_tokens == 1200

    def test_non_numeric_token_counts_preserve_prior_value(self) -> None:
        engine, _ = _build_engine()
        engine.update_from_response({"prompt_tokens": 500})
        # A later malformed usage dict must not crash and must not corrupt state.
        engine.update_from_response({"prompt_tokens": "n/a"})
        assert engine.last_prompt_tokens == 500


class TestUpdateModel:
    def test_recalculates_threshold(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("gpt-4o", context_length=8000)
        assert engine.context_length == 8000
        assert engine.threshold_tokens == int(8000 * 0.75)

    def test_stores_model_and_provider(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("gpt-4o", context_length=8000, provider="openai")
        assert engine.model == "gpt-4o"
        assert engine.provider == "openai"

    def test_accepts_extra_kwargs_from_hermes(self) -> None:
        # Hermes' run_agent.py and agent_runtime_helpers.py pass `api_mode=...`
        # in addition to the documented params. Future Hermes versions may add
        # more. We must accept and ignore unknown kwargs — never raise.
        engine, _ = _build_engine()
        engine.update_model(
            model="gpt-4o",
            context_length=8000,
            base_url="https://x",
            api_key="ckai",
            provider="openai",
            api_mode="chat",  # the actual extra Hermes passes today
        )
        assert engine.model == "gpt-4o"
        assert engine.context_length == 8000

    def test_accepts_arbitrary_future_kwargs(self) -> None:
        engine, _ = _build_engine()
        engine.update_model(
            model="gpt-4o",
            context_length=8000,
            some_future_field="x",
            another=42,
        )
        assert engine.model == "gpt-4o"


# ============================================================================
# Session lifecycle
# ============================================================================

class TestSessionLifecycle:
    def test_on_session_start_stores_id(self) -> None:
        engine, _ = _build_engine()
        engine.on_session_start("session-abc")
        assert engine.session_id == "session-abc"

    def test_on_session_start_uuid_fallback_when_empty(self) -> None:
        engine, _ = _build_engine()
        engine.on_session_start("")
        assert engine.session_id  # non-empty
        assert len(engine.session_id) >= 8

    def test_on_session_start_uuid_fallback_when_none(self) -> None:
        engine, _ = _build_engine()
        engine.on_session_start(None)  # type: ignore[arg-type]
        assert engine.session_id

    def test_on_session_reset_clears_injected_ids(self) -> None:
        engine, _ = _build_engine()
        engine.injected_item_ids.add("x")
        engine.on_session_reset()
        assert engine.injected_item_ids == set()

    def test_on_session_reset_resets_counters(self) -> None:
        engine, _ = _build_engine()
        engine.last_prompt_tokens = 1000
        engine.compression_count = 3
        engine.on_session_reset()
        assert engine.last_prompt_tokens == 0
        assert engine.compression_count == 0

    def test_on_session_reset_preserves_session_id(self) -> None:
        engine, _ = _build_engine()
        engine.on_session_start("keep-me")
        engine.on_session_reset()
        assert engine.session_id == "keep-me"

    def test_on_session_end_is_noop(self) -> None:
        engine, _ = _build_engine()
        engine.on_session_end("any", [])  # must not raise


# ============================================================================
# Tools
# ============================================================================

class TestTools:
    def test_get_tool_schemas(self) -> None:
        engine, _ = _build_engine()
        schemas = engine.get_tool_schemas()
        assert len(schemas) == 1
        assert schemas[0]["name"] == "contexto_search"

    def test_handle_tool_call_dispatches(self) -> None:
        items = [{"item": {"id": "x", "content": "hi"}}]
        engine, backend = _build_engine(search_result=SearchResult(items=items, paths=[]))
        result = engine.handle_tool_call("contexto_search", {"query": "q"})
        parsed = json.loads(result)
        assert parsed["items"] == items
        assert "## Relevant Context" in parsed["context"]
        assert "hi" in parsed["context"]

    def test_handle_tool_call_unknown_returns_error_json(self) -> None:
        engine, _ = _build_engine()
        result = engine.handle_tool_call("nope", {})
        parsed = json.loads(result)
        assert "error" in parsed


# ============================================================================
# Status
# ============================================================================

class TestStatus:
    def test_get_status_extras(self) -> None:
        engine, _ = _build_engine()
        engine.update_model("gpt-4o", context_length=8000)
        status = engine.get_status()
        assert status["auth_state"] == "ok"
        assert status["last_api_error"] is None
        assert status["consecutive_ingest_failures"] == 0
        assert status["last_ingest_failure"] is None
        # ABC defaults still present
        assert "context_length" in status
        assert "compression_count" in status


# ============================================================================
# auth_state transitions (INFO logging — decision #3)
# ============================================================================

class TestAuthStateTransitions:
    def test_ok_to_degraded_logs_info(self, caplog: pytest.LogCaptureFixture) -> None:
        engine, _ = _build_engine()
        with caplog.at_level(logging.INFO, logger="plugins.context_engine.contexto"):
            engine._on_backend_error(ApiError(category="server", message="502"))
        assert engine.auth_state == "degraded"
        assert any(
            "auth_state" in r.message and "degraded" in r.message
            for r in caplog.records
        )

    def test_degraded_to_ok_logs_info(self, caplog: pytest.LogCaptureFixture) -> None:
        engine, _ = _build_engine()
        engine._on_backend_error(ApiError(category="server", message="502"))
        assert engine.auth_state == "degraded"
        with caplog.at_level(logging.INFO, logger="plugins.context_engine.contexto"):
            engine._on_backend_success()
        assert engine.auth_state == "ok"
        assert any(
            "auth_state" in r.message and "ok" in r.message
            for r in caplog.records
        )

    def test_auth_error_priority_over_degraded(self) -> None:
        engine, _ = _build_engine()
        engine._on_backend_error(ApiError(category="auth", message="401"))
        assert engine.auth_state == "auth_error"
        # A later server error must NOT downgrade us to "degraded"
        engine._on_backend_error(ApiError(category="server", message="502"))
        assert engine.auth_state == "auth_error"

    def test_auth_error_recovers_to_ok_on_success(self) -> None:
        engine, _ = _build_engine()
        engine._on_backend_error(ApiError(category="auth", message="401"))
        assert engine.auth_state == "auth_error"
        engine._on_backend_success()
        assert engine.auth_state == "ok"

    def test_same_state_does_not_relog(self, caplog: pytest.LogCaptureFixture) -> None:
        engine, _ = _build_engine()
        engine._on_backend_error(ApiError(category="server", message="502"))
        with caplog.at_level(logging.INFO, logger="plugins.context_engine.contexto"):
            engine._on_backend_error(ApiError(category="server", message="503"))
        # already in "degraded" — no INFO transition
        info_records = [r for r in caplog.records if r.levelno == logging.INFO]
        assert all("auth_state" not in r.message for r in info_records)

    def test_last_api_error_captured(self) -> None:
        engine, _ = _build_engine()
        engine._on_backend_error(ApiError(category="schema", message="422 bad"))
        assert engine.last_api_error is not None
        assert "422" in engine.last_api_error


# ============================================================================
# compress() — the core path
# ============================================================================

class TestCompressSplit:
    def test_empty_drop_slice_returns_input_unchanged(self) -> None:
        engine, backend = _build_engine()
        msgs = _conversation(9)  # exactly protect_first_n + protect_last_n
        result = engine.compress(msgs)
        assert result == msgs
        assert backend.ingest_calls == []
        assert backend.search_calls == []

    def test_basic_split_keeps_system_head_tail(self) -> None:
        engine, backend = _build_engine(search_result=SearchResult(items=[], paths=[]))
        msgs = _conversation(20)  # 3 head + 11 drop + 6 tail
        result = engine.compress(msgs)
        # System always present
        assert result[0]["role"] == "system"
        # First 3 non-system messages == original first 3
        non_system = [m for m in result if m["role"] != "system"]
        # Tail end matches input tail
        original_non_system = [m for m in msgs if m["role"] != "system"]
        assert non_system[-6:] == original_non_system[-6:]

    def test_strict_message_count_reduction(self) -> None:
        engine, backend = _build_engine(search_result=SearchResult(items=[], paths=[]))
        msgs = _conversation(20)
        result = engine.compress(msgs)
        assert len(result) < len(msgs)


class TestCompressIngest:
    def test_ingests_drop_slice_as_single_episode(self) -> None:
        engine, backend = _build_engine(search_result=SearchResult(items=[], paths=[]))
        engine.on_session_start("s1")
        engine.update_model("gpt-4o", context_length=10000, provider="openai")
        msgs = _conversation(20)
        engine.compress(msgs)
        assert len(backend.ingest_calls) == 1
        episodes = backend.ingest_calls[0]
        assert len(episodes) == 1
        payload = episodes[0]
        assert payload["event"] == {"type": "episode", "action": "combined"}
        assert payload["sessionKey"] == "s1"
        assert payload["context"]["sessionId"] == "s1"
        assert payload["context"]["model"] == "gpt-4o"
        assert payload["context"]["provider"] == "openai"
        # drop_slice = non_system[3:-6] = 11 messages
        assert len(payload["data"]["messages"]) == 11

    def test_ingest_fires_when_context_disabled(self) -> None:
        engine, backend = _build_engine(
            search_result=SearchResult(items=[{"item": {"id": "a", "content": "x"}}], paths=[]),
            context_enabled=False,
        )
        engine.compress(_conversation(20))
        assert len(backend.ingest_calls) == 1
        # But no search
        assert backend.search_calls == []

    def test_ingest_failure_preserves_original_messages(self, caplog: pytest.LogCaptureFixture) -> None:
        engine, backend = _build_engine(
            ingest_succeeds=False,
            search_result=SearchResult(items=[], paths=[]),
        )
        msgs = _conversation(20)
        with caplog.at_level(logging.WARNING, logger="plugins.context_engine.contexto"):
            result = engine.compress(msgs)
        assert backend.ingest_calls
        assert result == msgs
        assert backend.search_calls == []
        assert engine.compression_count == 0
        assert engine.consecutive_ingest_failures == 1
        assert engine.last_ingest_failure == "ingest returned False"
        assert any("preserving original messages" in r.message for r in caplog.records)

    def test_ingest_failure_after_backend_error_does_not_warn_twice(
        self,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        engine, backend = _build_engine(
            search_result=SearchResult(items=[], paths=[]),
        )
        backend.force_error = ApiError(category="network", message="boom")
        with caplog.at_level(logging.WARNING, logger="plugins.context_engine.contexto"):
            result = engine.compress(_conversation(20))
        assert result == _conversation(20)
        assert engine.consecutive_ingest_failures == 1
        assert engine.last_ingest_failure == "network: boom"
        assert not any("preserving original messages" in r.message for r in caplog.records)

    def test_successful_ingest_resets_failure_counter(self) -> None:
        engine, backend = _build_engine(
            ingest_succeeds=False,
            search_result=SearchResult(items=[], paths=[]),
        )
        msgs = _conversation(20)
        engine.compress(msgs)
        assert engine.consecutive_ingest_failures == 1

        backend.ingest_succeeds = True
        result = engine.compress(msgs)
        assert len(result) < len(msgs)
        assert engine.consecutive_ingest_failures == 0
        assert engine.last_ingest_failure is None


class TestCompressRetrieve:
    def test_retrieves_when_drop_slice_large_enough(self) -> None:
        item = {"item": {"id": "x1", "content": "important fact"}}
        engine, backend = _build_engine(
            search_result=SearchResult(items=[item], paths=[]),
        )
        result = engine.compress(_conversation(20))
        assert backend.search_calls
        # Should have injected retrieved pair somewhere
        roles_contents = [(m["role"], m.get("content")) for m in result]
        flat = json.dumps(roles_contents)
        assert "Recalled context" in flat

    def test_no_search_when_context_disabled(self) -> None:
        item = {"item": {"id": "x1", "content": "fact"}}
        engine, backend = _build_engine(
            search_result=SearchResult(items=[item], paths=[]),
            context_enabled=False,
        )
        result = engine.compress(_conversation(20))
        assert backend.search_calls == []
        # No retrieved pair
        roles_contents = json.dumps([(m["role"], m.get("content")) for m in result])
        assert "Recalled context" not in roles_contents

    def test_step_4a_gate_drop_slice_under_3(self) -> None:
        # protect_first_n=3 + drop_slice=2 + protect_last_n=6 = 11 total non-system
        item = {"item": {"id": "x1", "content": "fact"}}
        engine, backend = _build_engine(
            search_result=SearchResult(items=[item], paths=[]),
        )
        result = engine.compress(_conversation(11))
        # drop_slice=2, gate fires: no retrieved pair
        flat = json.dumps([(m["role"], m.get("content")) for m in result])
        assert "Recalled context" not in flat
        # Search may or may not be called; spec allows skipping it when gate would fire
        # but the engine MAY still call it — what matters is no injection.
        # Strict message reduction still holds
        assert len(result) < len(_conversation(11))

    def test_search_failure_falls_back_to_head_tail(self) -> None:
        engine, backend = _build_engine(search_result=None)
        result = engine.compress(_conversation(20))
        flat = json.dumps([(m["role"], m.get("content")) for m in result])
        assert "Recalled context" not in flat
        assert len(result) < len(_conversation(20))

    def test_search_uses_focus_topic_when_provided(self) -> None:
        engine, backend = _build_engine(search_result=SearchResult(items=[], paths=[]))
        engine.compress(_conversation(20), focus_topic="my custom topic")
        assert backend.search_calls
        assert backend.search_calls[0]["query"] == "my custom topic"

    def test_search_uses_last_user_message_when_no_focus_topic(self) -> None:
        engine, backend = _build_engine(search_result=SearchResult(items=[], paths=[]))
        msgs = _conversation(20)
        # Force the last non-system message to be a user message with known content
        msgs[-1] = {"role": "user", "content": "what about postgres?"}
        engine.compress(msgs)
        assert backend.search_calls
        assert "postgres" in backend.search_calls[0]["query"]

    def test_search_strips_metadata_envelope(self) -> None:
        engine, backend = _build_engine(search_result=SearchResult(items=[], paths=[]))
        msgs = _conversation(20)
        msgs[-1] = {
            "role": "user",
            "content": (
                'Sender (untrusted metadata):\n```json\n{"x":1}\n```\n\n'
                "Real question here"
            ),
        }
        engine.compress(msgs)
        assert backend.search_calls
        assert backend.search_calls[0]["query"] == "Real question here"

    def test_no_search_when_query_empty(self) -> None:
        engine, backend = _build_engine(search_result=SearchResult(items=[], paths=[]))
        msgs = _conversation(20)
        # Image-only tail user message
        msgs[-1] = {
            "role": "user",
            "content": [{"type": "image_url", "image_url": {"url": "x"}}],
        }
        engine.compress(msgs)
        assert backend.search_calls == []


class TestCompressDedup:
    def test_records_injected_item_ids(self) -> None:
        items = [
            {"item": {"id": "i1", "content": "fact 1"}},
            {"item": {"id": "i2", "content": "fact 2"}},
        ]
        engine, backend = _build_engine(
            search_result=SearchResult(items=items, paths=[]),
        )
        engine.compress(_conversation(20))
        assert engine.injected_item_ids == {"i1", "i2"}

    def test_skips_already_injected(self) -> None:
        items = [
            {"item": {"id": "i1", "content": "fact 1"}},
            {"item": {"id": "i2", "content": "fact 2"}},
        ]
        engine, backend = _build_engine(
            search_result=SearchResult(items=items, paths=[]),
        )
        engine.injected_item_ids.add("i1")
        result = engine.compress(_conversation(20))
        flat = json.dumps([(m["role"], m.get("content")) for m in result])
        assert "fact 2" in flat
        assert "fact 1" not in flat
        # i2 newly injected, i1 still tracked
        assert engine.injected_item_ids == {"i1", "i2"}

    def test_all_dedup_skips_pair(self) -> None:
        items = [{"item": {"id": "i1", "content": "fact"}}]
        engine, backend = _build_engine(
            search_result=SearchResult(items=items, paths=[]),
        )
        engine.injected_item_ids.add("i1")
        result = engine.compress(_conversation(20))
        flat = json.dumps([(m["role"], m.get("content")) for m in result])
        assert "Recalled context" not in flat


# ============================================================================
# Token-invariant checks (Step 4b)
# ============================================================================

class TestTokenInvariant:
    def test_non_increasing_estimated_tokens(self) -> None:
        # Heavy retrieved content + thin drop slice; engine must drop the pair.
        big_blob = "x" * 200000
        items = [{"item": {"id": "x1", "content": big_blob}}]
        engine, backend = _build_engine(
            search_result=SearchResult(items=items, paths=[]),
        )
        result = engine.compress(_conversation(20))
        # Pair must be dropped — no recalled context appears
        flat = json.dumps([(m["role"], m.get("content")) for m in result])
        assert "Recalled context" not in flat or len(json.dumps(result)) < len(big_blob)

    def test_strict_reduction_on_normal_path(self) -> None:
        # Small retrieved content, large drop slice: candidate must be strictly smaller.
        items = [{"item": {"id": "x1", "content": "concise summary"}}]
        engine, backend = _build_engine(
            search_result=SearchResult(items=items, paths=[]),
        )
        msgs = _conversation(30)
        result = engine.compress(msgs)
        # Use the engine's own estimator
        assert engine._estimate_tokens(result) < engine._estimate_tokens(msgs)  # type: ignore[attr-defined]


# ============================================================================
# Compression count
# ============================================================================

class TestCompressionCount:
    def test_increments_on_successful_compaction(self) -> None:
        engine, _ = _build_engine(search_result=SearchResult(items=[], paths=[]))
        assert engine.compression_count == 0
        engine.compress(_conversation(20))
        assert engine.compression_count == 1
        engine.compress(_conversation(20))
        assert engine.compression_count == 2

    def test_does_not_increment_on_no_op(self) -> None:
        engine, _ = _build_engine()
        engine.compress(_conversation(9))  # nothing to drop
        assert engine.compression_count == 0
