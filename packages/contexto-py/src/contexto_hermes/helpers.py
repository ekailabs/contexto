"""Helpers ported from the TS @ekai/contexto package.

The `build_episode_payload` output must achieve canonical-JSON parity with TS
(after `json.dumps(..., sort_keys=True, ensure_ascii=False)`). Three TS behaviors
this module mirrors carefully:

1. `JSON.stringify` omits keys whose value is `undefined`. Python equivalent:
   conditionally exclude None values.
2. `new Date().toISOString()` emits a `Z` suffix. Python's `datetime.isoformat()`
   emits `+00:00`. We format manually to match.
3. The `agent` field is omitted entirely in episode payloads (TS passes
   `undefined`).
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any, Callable

from .types import WebhookPayload

# Verbatim from packages/contexto/src/helpers.ts:4 — including the /i flag.
_METADATA_ENVELOPE_RE = re.compile(
    r"^Sender\s*\(untrusted metadata\)\s*:\s*```json\s*[\s\S]*?```\s*",
    re.IGNORECASE,
)


def strip_metadata_envelope(text: str) -> str:
    """Strip the OpenClaw metadata envelope prefix from a user message."""
    return _METADATA_ENVELOPE_RE.sub("", text).strip()


def normalize_message_text(message: dict[str, Any]) -> str:
    """Extract a single text string from a message regardless of content shape.

    - `content: str` → return as-is.
    - `content: list[part]` → concatenate `part.text` for parts with `type == "text"`.
    - `content: None` (assistant with tool_calls only) → empty string.
    - Tool-role messages → use `content` (always string per OpenAI spec).
    - Missing `content` key → empty string.
    """
    content = message.get("content")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text = part.get("text")
                if isinstance(text, str):
                    parts.append(text)
        return "".join(parts)
    return ""


def format_search_results(items: list[Any]) -> str:
    """Render mindmap search items as a `## Relevant Context` markdown block.

    Mirrors `formatSearchResults` in packages/contexto/src/helpers.ts:11-44.
    """
    rendered: list[str] = []
    for entry in items:
        if isinstance(entry, dict) and "item" in entry:
            item = entry["item"]
        else:
            item = entry
        metadata = item.get("metadata", {}) if isinstance(item, dict) else {}
        content = item.get("content", "") if isinstance(item, dict) else str(item)

        if metadata.get("source") != "summary":
            rendered.append(f"- {content}")
            continue

        parts: list[str] = [content]

        evidence_refs = metadata.get("evidence_refs")
        if isinstance(evidence_refs, list) and len(evidence_refs) > 0:
            refs = ", ".join(
                f"{ref.get('type')}:{ref.get('value')}"
                for ref in evidence_refs
                if isinstance(ref, dict)
            )
            parts.append(f"Refs: {refs}")

        trace_ref = metadata.get("trace_ref")
        if trace_ref:
            parts.append(f"Trace: {trace_ref}")

        header_bits: list[str] = []
        status = metadata.get("status")
        if status:
            header_bits.append(str(status))
        confidence = metadata.get("confidence")
        if confidence is not None:
            header_bits.append(f"confidence: {confidence}")
        header = " | ".join(header_bits)

        body = "\n".join(parts)
        rendered.append(f"### [{header}]\n{body}" if header else body)

    return "## Relevant Context\n\n" + "\n\n".join(rendered)


def _format_z_timestamp(dt: datetime) -> str:
    """Emit `2026-05-23T18:30:00.000Z` — TS-compatible (milliseconds + Z suffix).

    `datetime.isoformat()` produces microseconds + `+00:00`; TS produces
    milliseconds + `Z`. We bridge the gap manually.
    """
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    else:
        dt = dt.astimezone(timezone.utc)
    millis = dt.microsecond // 1000
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{millis:03d}Z"


def build_episode_payload(
    messages: list[dict[str, Any]],
    session_id: str,
    session_key: str,
    runtime_context: dict[str, Any],
    now: Callable[[], datetime] | None = None,
) -> WebhookPayload:
    """Build a single episode WebhookPayload for ingestion.

    Mirrors TS `buildEpisodePayload` (engine/utils.ts:34-47) which calls
    `buildPayload('episode', 'combined', sessionKey, {...}, undefined, {messages})`.

    TS behavior reproduced:
    - `agent` field omitted entirely (TS passes `undefined`).
    - `context.model` / `context.provider` omitted when None (TS `undefined`).
    - Timestamp is `Z`-suffixed.
    """
    context: dict[str, Any] = {"sessionId": session_id}
    model = runtime_context.get("model")
    if model is not None:
        context["model"] = model
    provider = runtime_context.get("provider")
    if provider is not None:
        context["provider"] = provider

    clock = now or (lambda: datetime.now(timezone.utc))
    timestamp = _format_z_timestamp(clock())

    return {
        "event": {"type": "episode", "action": "combined"},
        "sessionKey": session_key,
        "timestamp": timestamp,
        "context": context,
        "data": {"messages": messages},
    }
