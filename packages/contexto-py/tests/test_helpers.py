"""Tests for contexto_hermes.helpers — TS parity helpers."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from contexto_hermes.helpers import (
    build_episode_payload,
    format_search_results,
    normalize_message_text,
    strip_metadata_envelope,
)


FIXTURES_PATH = Path(__file__).parent / "fixtures" / "episode_payload.json"


def _canonical(obj: dict) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False)


def _frozen_now(iso: str):
    """Return a no-arg callable producing the given UTC datetime."""
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return lambda: dt


class TestStripMetadataEnvelope:
    def test_present(self) -> None:
        text = (
            'Sender (untrusted metadata):\n'
            '```json\n{"sender":"alice"}\n```\n\n'
            "Actual message body"
        )
        assert strip_metadata_envelope(text) == "Actual message body"

    def test_case_insensitive(self) -> None:
        text = (
            'sender (UNTRUSTED Metadata) :\n'
            '```json\n{"x":1}\n```\n'
            "body"
        )
        assert strip_metadata_envelope(text) == "body"

    def test_absent_returns_trimmed(self) -> None:
        assert strip_metadata_envelope("  plain text  ") == "plain text"

    def test_empty_string(self) -> None:
        assert strip_metadata_envelope("") == ""


class TestNormalizeMessageText:
    def test_string_content(self) -> None:
        assert normalize_message_text({"role": "user", "content": "hello"}) == "hello"

    def test_list_content_text_only(self) -> None:
        msg = {"role": "user", "content": [
            {"type": "text", "text": "part1"},
            {"type": "text", "text": "part2"},
        ]}
        assert normalize_message_text(msg) == "part1part2"

    def test_list_content_mixed_image_and_text(self) -> None:
        msg = {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://x"}},
            {"type": "text", "text": "describe"},
        ]}
        assert normalize_message_text(msg) == "describe"

    def test_list_content_image_only_returns_empty(self) -> None:
        msg = {"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": "https://x"}},
        ]}
        assert normalize_message_text(msg) == ""

    def test_none_content(self) -> None:
        # Assistant message with tool_calls only
        msg = {"role": "assistant", "content": None, "tool_calls": [{"id": "x"}]}
        assert normalize_message_text(msg) == ""

    def test_tool_role_string_content(self) -> None:
        msg = {"role": "tool", "content": "tool output", "tool_call_id": "x"}
        assert normalize_message_text(msg) == "tool output"

    def test_missing_content_key(self) -> None:
        assert normalize_message_text({"role": "user"}) == ""


class TestFormatSearchResults:
    def test_header_always_present(self) -> None:
        out = format_search_results([])
        assert out.startswith("## Relevant Context\n\n")

    def test_non_summary_item_uses_bullet(self) -> None:
        items = [{"item": {"content": "raw stuff", "metadata": {"source": "raw"}}}]
        out = format_search_results(items)
        assert out == "## Relevant Context\n\n- raw stuff"

    def test_summary_item_no_meta(self) -> None:
        items = [{"item": {"content": "summary body", "metadata": {"source": "summary"}}}]
        out = format_search_results(items)
        assert out == "## Relevant Context\n\nsummary body"

    def test_summary_with_evidence_refs(self) -> None:
        items = [{"item": {
            "content": "decision: use Postgres",
            "metadata": {
                "source": "summary",
                "evidence_refs": [
                    {"type": "msg", "value": "m1"},
                    {"type": "msg", "value": "m2"},
                ],
            },
        }}]
        out = format_search_results(items)
        assert "decision: use Postgres\nRefs: msg:m1, msg:m2" in out

    def test_summary_with_trace_ref(self) -> None:
        items = [{"item": {
            "content": "body",
            "metadata": {"source": "summary", "trace_ref": "t-99"},
        }}]
        out = format_search_results(items)
        assert "body\nTrace: t-99" in out

    def test_summary_with_status_and_confidence_header(self) -> None:
        items = [{"item": {
            "content": "body",
            "metadata": {
                "source": "summary",
                "status": "confirmed",
                "confidence": 0.92,
            },
        }}]
        out = format_search_results(items)
        assert "### [confirmed | confidence: 0.92]\nbody" in out

    def test_summary_status_only_header(self) -> None:
        items = [{"item": {
            "content": "body",
            "metadata": {"source": "summary", "status": "draft"},
        }}]
        out = format_search_results(items)
        assert "### [draft]\nbody" in out

    def test_multiple_items_separated_by_blank_line(self) -> None:
        items = [
            {"item": {"content": "a", "metadata": {"source": "raw"}}},
            {"item": {"content": "b", "metadata": {"source": "raw"}}},
        ]
        out = format_search_results(items)
        assert out == "## Relevant Context\n\n- a\n\n- b"

    def test_handles_item_without_envelope(self) -> None:
        # Some callers pass {item: ...}; others pass the item directly.
        items = [{"content": "direct", "metadata": {"source": "raw"}}]
        out = format_search_results(items)
        assert out == "## Relevant Context\n\n- direct"

    def test_handles_non_dict_item(self) -> None:
        out = format_search_results(["bare string item"])
        assert out == "## Relevant Context\n\n- bare string item"

    def test_handles_non_dict_wrapped_item(self) -> None:
        out = format_search_results([{"item": "wrapped string item"}])
        assert out == "## Relevant Context\n\n- wrapped string item"


class TestBuildEpisodePayload:
    @pytest.fixture(scope="class")
    def fixtures(self) -> dict:
        return json.loads(FIXTURES_PATH.read_text())

    def _compare(self, fixture: dict, *, runtime_context: dict | None) -> None:
        inputs = fixture["inputs"]
        expected_obj = json.loads(fixture["serialized"])
        # Frozen timestamp: parse it from the expected serialized form.
        now = _frozen_now(expected_obj["timestamp"])
        actual = build_episode_payload(
            messages=inputs["messages"],
            session_id=inputs["sessionId"],
            session_key=inputs["sessionKey"],
            runtime_context=runtime_context if runtime_context is not None else {},
            now=now,
        )
        assert _canonical(actual) == _canonical(expected_obj)

    def test_basic_parity(self, fixtures: dict) -> None:
        self._compare(fixtures["basic"], runtime_context={"model": "gpt-4o", "provider": "openai"})

    def test_no_runtime_context_parity(self, fixtures: dict) -> None:
        # Python: empty dict; TS: undefined. Both should produce context={"sessionId": ...}.
        self._compare(fixtures["no_runtime_context"], runtime_context={})

    def test_only_model_set_parity(self, fixtures: dict) -> None:
        self._compare(fixtures["only_model_set"], runtime_context={"model": "gpt-4o-mini"})

    def test_distinct_session_key_parity(self, fixtures: dict) -> None:
        self._compare(
            fixtures["distinct_session_key"],
            runtime_context={"model": "claude-opus-4-7", "provider": "anthropic"},
        )

    def test_multipart_content_parity(self, fixtures: dict) -> None:
        self._compare(
            fixtures["multipart_content"],
            runtime_context={"model": "gpt-4o", "provider": "openai"},
        )

    def test_omits_none_values(self) -> None:
        out = build_episode_payload(
            messages=[],
            session_id="s",
            session_key="s",
            runtime_context={"model": None, "provider": "openai"},
            now=_frozen_now("2026-05-23T18:30:00.000Z"),
        )
        assert out["context"] == {"sessionId": "s", "provider": "openai"}
        assert "model" not in out["context"]

    def test_agent_field_absent(self) -> None:
        out = build_episode_payload(
            messages=[],
            session_id="s",
            session_key="s",
            runtime_context={},
            now=_frozen_now("2026-05-23T18:30:00.000Z"),
        )
        assert "agent" not in out

    def test_z_suffixed_timestamp(self) -> None:
        # datetime.now(timezone.utc).isoformat() produces "+00:00", not "Z".
        # We must emit Z to match TS.
        out = build_episode_payload(
            messages=[],
            session_id="s",
            session_key="s",
            runtime_context={},
            now=_frozen_now("2026-05-23T18:30:00.000Z"),
        )
        assert out["timestamp"] == "2026-05-23T18:30:00.000Z"

    def test_default_now_when_omitted(self) -> None:
        # Just verify it doesn't crash and produces a Z-suffixed ISO string.
        out = build_episode_payload(
            messages=[],
            session_id="s",
            session_key="s",
            runtime_context={},
        )
        ts = out["timestamp"]
        assert ts.endswith("Z")
        # Parses cleanly
        datetime.fromisoformat(ts.replace("Z", "+00:00"))

    def test_data_messages_preserved_unchanged(self) -> None:
        msgs = [{"role": "user", "content": [{"type": "text", "text": "hi"}]}]
        out = build_episode_payload(
            messages=msgs,
            session_id="s",
            session_key="s",
            runtime_context={},
            now=_frozen_now("2026-05-23T18:30:00.000Z"),
        )
        assert out["data"]["messages"] is msgs or out["data"]["messages"] == msgs
