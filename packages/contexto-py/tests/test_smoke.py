"""Live smoke tests — gated on CONTEXTO_API_KEY.

Skipped when the key is not set. Run intentionally:

    CONTEXTO_API_KEY=ckai_... pytest tests/test_smoke.py
"""

from __future__ import annotations

import json
import os
import uuid

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("CONTEXTO_API_KEY"),
    reason="CONTEXTO_API_KEY not set",
)


def test_ingest_and_search_round_trip() -> None:
    from contexto_hermes.engine import ContextoEngine

    engine = ContextoEngine.from_env()
    assert engine is not None
    session_id = f"smoke-{uuid.uuid4().hex[:8]}"
    engine.on_session_start(session_id)
    engine.update_model("gpt-4o", context_length=8000, provider="openai")

    # Drive one compaction with a text-heavy conversation.
    msgs = [{"role": "system", "content": "You are helpful."}]
    msgs.extend(
        {"role": "user" if i % 2 == 0 else "assistant",
         "content": f"smoke-fact #{i}: the answer is forty-two"}
        for i in range(20)
    )
    result = engine.compress(msgs)
    assert len(result) < len(msgs)

    # Search — may need a brief moment for the just-ingested episode to be indexed.
    search_result = engine.client.search(
        "smoke-fact",
        max_results=5,
        filter={"source": "summary"},
        min_score=0.0,
    )
    # We only assert "didn't blow up". Empty results are acceptable on a fresh account
    # or before indexing completes — the existence of a SearchResult (not None) is enough.
    assert search_result is not None


def test_tool_handle_round_trip() -> None:
    from contexto_hermes.engine import ContextoEngine

    engine = ContextoEngine.from_env()
    assert engine is not None
    engine.on_session_start(f"smoke-tool-{uuid.uuid4().hex[:8]}")

    raw = engine.handle_tool_call(
        "contexto_search",
        {"query": "hello", "max_results": 3},
        messages=[],
    )
    parsed = json.loads(raw)
    assert "items" in parsed
    assert "paths" in parsed
