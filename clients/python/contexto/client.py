"""Contexto self-hosted API client.

Targets the OSS memory engine exposed by `packages/openrouter` (default
http://localhost:4010), which embeds the memory router. Endpoints:
  POST /v1/agents     register an agent
  POST /v1/ingest     ingest a turn (LLM-extracts components into 3 sectors)
  POST /v1/search     query the working memory across sectors
  GET  /v1/summary    list recent memories
"""

from __future__ import annotations

from typing import Optional

import httpx

DEFAULT_BASE = "http://localhost:4010"


def _raise_with_body(resp: httpx.Response) -> None:
    """raise_for_status() but with the server's response body in the message.

    httpx's default error string is just status + URL — not enough to debug
    extraction or embedding failures from the selfhost server.
    """
    if resp.is_success:
        return
    body = resp.text[:1000]
    raise httpx.HTTPStatusError(
        f"{resp.status_code} {resp.reason_phrase} from {resp.request.url}: {body}",
        request=resp.request,
        response=resp,
    )


class ContextoClient:
    """Client for the self-hosted Contexto memory API."""

    def __init__(self, base_url: str = DEFAULT_BASE, timeout: float = 300.0):
        # Default 300s: /v1/ingest runs LLM extraction + embeddings server-side.
        # Empirical: ~48s for a 4K-char hermes turn; ~120-180s for the long-tail
        # outliers (longer turns + a slow Gemini response). 300s catches the
        # 99th percentile without papering over a real hang.
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers = {"Content-Type": "application/json"}

    def list_agents(self) -> dict:
        resp = httpx.get(f"{self.base_url}/v1/agents", headers=self.headers, timeout=self.timeout)
        _raise_with_body(resp)
        return resp.json()

    def register_agent(
        self,
        agent_id: str,
        name: Optional[str] = None,
        soul: Optional[str] = None,
        relevance_prompt: Optional[str] = None,
    ) -> dict:
        """Register a new agent. Idempotent on the slug."""
        body: dict = {"id": agent_id}
        if name is not None:
            body["name"] = name
        if soul is not None:
            body["soul"] = soul
        if relevance_prompt is not None:
            body["relevancePrompt"] = relevance_prompt
        resp = httpx.post(
            f"{self.base_url}/v1/agents",
            headers=self.headers,
            json=body,
            timeout=self.timeout,
        )
        _raise_with_body(resp)
        return resp.json()

    def ingest(
        self,
        messages: list[dict],
        agent: str,
        user_id: Optional[str] = None,
    ) -> dict:
        """Ingest a sequence of {role, content} messages.

        At least one user-role message with non-empty content is required.
        Server runs LLM extraction and stores components across episodic,
        semantic, and procedural sectors.
        """
        body: dict = {"messages": messages, "agent": agent}
        if user_id:
            body["userId"] = user_id
        resp = httpx.post(
            f"{self.base_url}/v1/ingest",
            headers=self.headers,
            json=body,
            timeout=self.timeout,
        )
        _raise_with_body(resp)
        return resp.json()

    def search(self, query: str, agent: str, user_id: Optional[str] = None) -> dict:
        """Multi-sector cognitive memory query.

        Returns {workingMemory, perSector, agentId}. workingMemory is the
        cap-limited cross-sector top hits; perSector is the per-sector lists.
        """
        body: dict = {"query": query, "agent": agent}
        if user_id:
            body["userId"] = user_id
        resp = httpx.post(
            f"{self.base_url}/v1/search",
            headers=self.headers,
            json=body,
            timeout=self.timeout,
        )
        _raise_with_body(resp)
        return resp.json()

    def summary(self, agent: str, limit: int = 50, user_id: Optional[str] = None) -> dict:
        params: dict = {"agent": agent, "limit": limit}
        if user_id:
            params["userId"] = user_id
        resp = httpx.get(
            f"{self.base_url}/v1/summary",
            headers=self.headers,
            params=params,
            timeout=self.timeout,
        )
        _raise_with_body(resp)
        return resp.json()

    def get_context_for_turn(
        self,
        query: str,
        agent: str,
        user_id: Optional[str] = None,
        max_results: int = 5,
    ) -> str:
        """Run a search and format workingMemory hits as a prompt-ready block."""
        result = self.search(query, agent=agent, user_id=user_id)
        items = (result or {}).get("workingMemory") or []
        parts = []
        for it in items[:max_results]:
            sector = it.get("sector", "?")
            score = it.get("score", 0)
            content = it.get("content", "").strip()
            if content:
                parts.append(f"[{sector} | score: {score:.2f}] {content}")
        return "\n---\n".join(parts)
