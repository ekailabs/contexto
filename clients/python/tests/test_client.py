"""Unit tests for ContextoClient — mocked HTTP, no selfhost required.

These are the tests CI will run. They cover request body shapes, default
behavior, and error-message formatting. A separate `test_live.py` covers
the integration path against a real selfhost.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from contexto import ContextoClient
from contexto.client import _raise_with_body, DEFAULT_BASE


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _Recorder:
    """Captures the last httpx.post / httpx.get call so tests can assert on it."""

    def __init__(self):
        self.calls: list[dict[str, Any]] = []
        self.next_response: httpx.Response | None = None

    def make_post(self):
        def _post(url, *, headers=None, json=None, timeout=None, **kwargs):
            self.calls.append({"method": "POST", "url": url, "headers": headers,
                               "json": json, "timeout": timeout})
            return self.next_response or _ok({})
        return _post

    def make_get(self):
        def _get(url, *, headers=None, params=None, timeout=None, **kwargs):
            self.calls.append({"method": "GET", "url": url, "headers": headers,
                               "params": params, "timeout": timeout})
            return self.next_response or _ok({})
        return _get


def _ok(body: dict, status: int = 200) -> httpx.Response:
    return httpx.Response(status, json=body, request=httpx.Request("POST", "http://x/"))


def _err(status: int, body: str) -> httpx.Response:
    return httpx.Response(status, content=body.encode(),
                          request=httpx.Request("POST", "http://x/"))


@pytest.fixture
def recorder(monkeypatch) -> _Recorder:
    rec = _Recorder()
    monkeypatch.setattr("contexto.client.httpx.post", rec.make_post())
    monkeypatch.setattr("contexto.client.httpx.get", rec.make_get())
    return rec


# ---------------------------------------------------------------------------
# Construction defaults
# ---------------------------------------------------------------------------

def test_default_base_is_localhost():
    c = ContextoClient()
    assert c.base_url == "http://localhost:4010"
    assert DEFAULT_BASE == "http://localhost:4010"


def test_default_timeout_is_generous():
    """Ingest runs server-side LLM extraction (Gemini ~10-180s depending on
    turn size). Default httpx timeout (5s) and even a 120s ceiling miss the
    long tail. 300s catches the 99th percentile."""
    assert ContextoClient().timeout >= 300.0


def test_base_url_trailing_slash_stripped():
    assert ContextoClient(base_url="http://h:4010/").base_url == "http://h:4010"


def test_no_auth_headers_for_selfhost():
    """Selfhost has no auth — Authorization header must not be set."""
    headers = ContextoClient().headers
    assert "Content-Type" in headers
    assert "Authorization" not in headers


# ---------------------------------------------------------------------------
# Request body shapes
# ---------------------------------------------------------------------------

def test_register_agent_minimal_body(recorder):
    recorder.next_response = _ok({"agent": {"id": "h"}})
    ContextoClient().register_agent("hermes")
    body = recorder.calls[-1]["json"]
    assert body == {"id": "hermes"}


def test_register_agent_includes_optional_fields(recorder):
    recorder.next_response = _ok({"agent": {"id": "h"}})
    ContextoClient().register_agent("hermes", name="Hermes", soul="be wise",
                                    relevance_prompt="filter noise")
    body = recorder.calls[-1]["json"]
    assert body == {"id": "hermes", "name": "Hermes", "soul": "be wise",
                    "relevancePrompt": "filter noise"}


def test_ingest_body_no_user_id(recorder):
    recorder.next_response = _ok({"stored": 1, "ids": ["a"], "agent": "h"})
    msgs = [{"role": "user", "content": "hi"}]
    ContextoClient().ingest(messages=msgs, agent="hermes")
    body = recorder.calls[-1]["json"]
    assert body == {"messages": msgs, "agent": "hermes"}
    assert "userId" not in body


def test_ingest_body_with_user_id(recorder):
    recorder.next_response = _ok({"stored": 1, "ids": ["a"], "agent": "h"})
    msgs = [{"role": "user", "content": "hi"}]
    ContextoClient().ingest(messages=msgs, agent="hermes", user_id="alex")
    assert recorder.calls[-1]["json"]["userId"] == "alex"


def test_ingest_url_and_timeout(recorder):
    recorder.next_response = _ok({"stored": 0, "ids": [], "agent": "h"})
    c = ContextoClient(base_url="http://h:4010", timeout=200)
    c.ingest(messages=[{"role": "user", "content": "x"}], agent="hermes")
    call = recorder.calls[-1]
    assert call["url"] == "http://h:4010/v1/ingest"
    assert call["timeout"] == 200


def test_search_body(recorder):
    recorder.next_response = _ok({"workingMemory": [], "perSector": {}, "agentId": "h"})
    ContextoClient().search("rate limiter", agent="hermes", user_id="alex")
    assert recorder.calls[-1]["json"] == {
        "query": "rate limiter", "agent": "hermes", "userId": "alex",
    }


def test_summary_uses_query_params(recorder):
    recorder.next_response = _ok({"recent": [], "summary": []})
    ContextoClient().summary(agent="hermes", limit=20, user_id="alex")
    call = recorder.calls[-1]
    assert call["method"] == "GET"
    assert call["url"].endswith("/v1/summary")
    assert call["params"] == {"agent": "hermes", "limit": 20, "userId": "alex"}


# ---------------------------------------------------------------------------
# Response handling
# ---------------------------------------------------------------------------

def test_get_context_for_turn_formats_working_memory(recorder):
    recorder.next_response = _ok({
        "workingMemory": [
            {"sector": "semantic", "score": 0.71, "content": "12 server racks"},
            {"sector": "episodic", "score": 0.65, "content": "rack 7 humidity"},
        ],
        "perSector": {}, "agentId": "h",
    })
    block = ContextoClient().get_context_for_turn("racks", agent="hermes")
    assert "[semantic | score: 0.71] 12 server racks" in block
    assert "[episodic | score: 0.65] rack 7 humidity" in block
    assert "\n---\n" in block


def test_get_context_for_turn_empty_returns_empty_string(recorder):
    recorder.next_response = _ok({"workingMemory": [], "perSector": {}, "agentId": "h"})
    assert ContextoClient().get_context_for_turn("anything", agent="h") == ""


def test_get_context_for_turn_skips_blank_content(recorder):
    recorder.next_response = _ok({
        "workingMemory": [
            {"sector": "semantic", "score": 0.71, "content": ""},
            {"sector": "semantic", "score": 0.65, "content": "   "},
            {"sector": "episodic", "score": 0.5, "content": "real one"},
        ],
        "perSector": {}, "agentId": "h",
    })
    block = ContextoClient().get_context_for_turn("anything", agent="h")
    # Only the real one survives; the empties are filtered out.
    assert "real one" in block
    assert block.count("[") == 1


def test_get_context_for_turn_caps_at_max_results(recorder):
    recorder.next_response = _ok({
        "workingMemory": [{"sector": "s", "score": 0.5, "content": f"item{i}"}
                          for i in range(10)],
        "perSector": {}, "agentId": "h",
    })
    block = ContextoClient().get_context_for_turn("q", agent="h", max_results=3)
    assert block.count("[") == 3


# ---------------------------------------------------------------------------
# Error surfacing
# ---------------------------------------------------------------------------

def test_raise_with_body_passes_on_success():
    """No-op for 2xx — the helper must not raise on success."""
    _raise_with_body(_ok({"ok": True}))


def test_raise_with_body_includes_status_and_body():
    resp = _err(500, '{"error":"gemini extract failed: 429 quota exceeded"}')
    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        _raise_with_body(resp)
    msg = str(excinfo.value)
    assert "500" in msg
    assert "gemini extract failed" in msg
    assert "quota exceeded" in msg


def test_raise_with_body_truncates_huge_bodies():
    resp = _err(500, "x" * 10_000)
    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        _raise_with_body(resp)
    # Body capped at 1000 chars in the message.
    assert len(str(excinfo.value)) < 1500


def test_ingest_propagates_server_error_with_body(recorder):
    recorder.next_response = _err(500, '{"error":"extraction failed: bad json"}')
    with pytest.raises(httpx.HTTPStatusError) as excinfo:
        ContextoClient().ingest(messages=[{"role": "user", "content": "x"}], agent="h")
    assert "extraction failed" in str(excinfo.value)


def test_ingest_returns_parsed_json_on_success(recorder):
    recorder.next_response = _ok({"stored": 3, "ids": ["a", "b", "c"], "agent": "h"})
    out = ContextoClient().ingest(messages=[{"role": "user", "content": "x"}], agent="h")
    assert out == {"stored": 3, "ids": ["a", "b", "c"], "agent": "h"}
