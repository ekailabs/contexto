"""Live integration test — exercises a real running Contexto selfhost.

Skips automatically if no selfhost is reachable. Run locally with the stack
up (`docker run ... contexto-selfhost`) to verify the client against the
real wire format.

In CI, this test is skipped unless the workflow brings up a stack.
"""

from __future__ import annotations

import os
import time
import uuid

import httpx
import pytest

from contexto import ContextoClient


_BASE = os.environ.get("CONTEXTO_BASE_URL", "http://localhost:4010")


def _selfhost_alive() -> bool:
    try:
        httpx.get(f"{_BASE}/v1/agents", timeout=2.0).raise_for_status()
        return True
    except Exception:
        return False


pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        not _selfhost_alive(),
        reason=f"Contexto selfhost not reachable at {_BASE}",
    ),
]


@pytest.fixture
def client() -> ContextoClient:
    return ContextoClient(base_url=_BASE)


@pytest.fixture
def slug() -> str:
    return f"pytest-{uuid.uuid4().hex[:8]}"


def test_register_then_ingest_then_search(client: ContextoClient, slug: str):
    client.register_agent(slug, name=slug)

    # Ingest one turn with a distinctive fact.
    fact = (
        "The matrix-greeter project tracks rate-limit clock skew with the "
        "histogram metric gateway_rate_limit_skew_ms."
    )
    r = client.ingest(
        messages=[
            {"role": "user", "content": fact},
            {"role": "assistant", "content": "Got it — tracked via the histogram."},
        ],
        agent=slug,
        user_id="pytest",
    )
    assert r["stored"] >= 1
    assert r["agent"] == slug

    # Give the server a moment to index.
    time.sleep(2)

    # Search recovers something semantically related.
    result = client.search("how do we monitor clock skew", agent=slug, user_id="pytest")
    wm = result.get("workingMemory") or []
    assert wm, "expected at least one working-memory hit after ingest"

    # And the formatted block matches the same content.
    block = client.get_context_for_turn("clock skew", agent=slug, user_id="pytest")
    assert block, "get_context_for_turn should return a non-empty block"
    assert "score:" in block and "[" in block


def test_summary_lists_recent(client: ContextoClient, slug: str):
    client.register_agent(slug, name=slug)
    client.ingest(
        messages=[
            {"role": "user", "content": "remember octarine is the user's favorite color"},
            {"role": "assistant", "content": "Noted."},
        ],
        agent=slug, user_id="pytest",
    )
    time.sleep(2)
    summary = client.summary(agent=slug, limit=20, user_id="pytest")
    assert "recent" in summary or "summary" in summary
