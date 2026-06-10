"""LocalBackend orchestrator. Same duck-typed contract as RemoteBackend.

`ingest` + `search` **never raise.** All errors land here, converted to
`False` / `None`. A search that simply finds nothing (empty store, nothing
above `min_score`) returns an empty `SearchResult` — `None` is reserved for
failures, matching `RemoteBackend`, so the tool layer can tell "no matches"
apart from "backend down".
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import asdict
from datetime import datetime, timezone
from typing import Any

import httpx

from ..types import SearchResult, WebhookPayload
from .clustering import Clusterer
from .embedder import Embedder, EmbedError
from .extractor import extract_episode_text
from .mindmap_types import (
    ConversationItem,
    EpisodeSummary,
    LocalBackendConfig,
    StoreState,
)
from .retrieval import beam_search
from .store import Store
from .summarizer import Summarizer, build_synthetic_summary

logger = logging.getLogger("plugins.context_engine.contexto")


def _utcnow_iso() -> str:
    dt = datetime.now(timezone.utc)
    millis = dt.microsecond // 1000
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{millis:03d}Z"


class LocalBackend:
    """Sync, never-raises backend. Lazy-loads the store on first use."""

    def __init__(
        self,
        config: LocalBackendConfig,
        *,
        embedder: Embedder | None = None,
        summarizer: Summarizer | None = None,
        store: Store | None = None,
        embed_transport: httpx.BaseTransport | None = None,
        llm_transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._config = config
        self._embedder = embedder if embedder is not None else Embedder(config, transport=embed_transport)
        self._summarizer = (
            summarizer if summarizer is not None
            else Summarizer(config, transport=llm_transport)
        )
        self._store = store if store is not None else Store(config.storage_path)
        self._clusterer = Clusterer(config.mindmap)
        self._state: StoreState | None = None

    # ----- public surface -------------------------------------------------
    def ingest(self, payloads: list[WebhookPayload]) -> bool:
        try:
            return self._ingest_inner(payloads)
        except Exception as exc:
            logger.error("[contexto:local] ingest crashed: %s", exc, exc_info=True)
            return False

    def search(
        self,
        query: str,
        max_results: int,
        filter: dict[str, Any] | None = None,
        min_score: float | None = None,
    ) -> SearchResult | None:
        try:
            return self._search_inner(query, max_results, filter, min_score)
        except Exception as exc:
            logger.error("[contexto:local] search crashed: %s", exc, exc_info=True)
            return None

    # ----- ingest internals -----------------------------------------------
    def _ingest_inner(self, payloads: list[WebhookPayload]) -> bool:
        if not payloads:
            return True

        episodes = [
            p for p in payloads
            if isinstance(p, dict)
            and isinstance(p.get("event"), dict)
            and p["event"].get("type") == "episode"
            and p["event"].get("action") == "combined"
        ]
        if not episodes:
            logger.debug("[contexto:local] no episode/combined events")
            return True

        state = self._load_state()

        new_items: list[ConversationItem] = []
        for ep in episodes:
            text = extract_episode_text(ep)
            if not text:
                logger.debug("[contexto:local] empty episode text, skipping")
                continue

            summary = self._summarize(text)

            try:
                embedding = self._embedder.embed(self._embed_input(summary))
            except EmbedError as exc:
                logger.error("[contexto:local] embed failed: %s", exc)
                return False

            new_items.append(self._build_item(ep, text, summary, embedding))

        if not new_items:
            return True

        try:
            new_state = self._clusterer.add(state, new_items)
        except Exception as exc:
            logger.error("[contexto:local] cluster failed: %s", exc, exc_info=True)
            return False

        # Spec §8: config_snapshot records the tunables that shaped this state
        # so a future reader can detect mismatched configs and decide how to
        # reconcile. Re-stamped on every save so it never lags behind the
        # active config.
        new_state.config_snapshot = self._config_snapshot()

        try:
            self._store.save(new_state)
        except OSError as exc:
            logger.error("[contexto:local] store.save failed: %s", exc)
            return False
        self._state = new_state
        logger.info(
            "[contexto:local] ingested %d episode(s); total=%d",
            len(new_items), new_state.stats.total_items,
        )
        return True

    def _summarize(self, text: str) -> EpisodeSummary:
        if not self._config.summarize:
            return build_synthetic_summary(text)
        return self._summarizer.summarize(text)

    def _embed_input(self, summary: EpisodeSummary) -> str:
        parts = [summary.summary]
        if summary.key_findings:
            findings = "\n".join(f"- {f}" for f in summary.key_findings)
            parts.append(f"\nKey findings:\n{findings}")
        return "\n".join(parts)

    def _build_item(
        self,
        ep: WebhookPayload,
        extracted_text: str,
        summary: EpisodeSummary,
        embedding: list[float],
    ) -> ConversationItem:
        # Stored content is exactly what was embedded.
        content = self._embed_input(summary)

        metadata: dict[str, Any] = {
            "source": "summary",
            "status": summary.status,
            "confidence": summary.confidence,
            "evidence_refs": [asdict(ref) for ref in summary.evidence_refs],
            "open_questions": summary.open_questions,
            "trace_ref": str(uuid.uuid4()),
            "sessionKey": ep.get("sessionKey"),
            "episode": {"extracted_text": extracted_text},
        }

        return ConversationItem(
            id=str(uuid.uuid4()),
            role="assistant",
            content=content,
            embedding=embedding,
            timestamp=ep.get("timestamp") or _utcnow_iso(),
            metadata=metadata,
        )

    # ----- search internals -----------------------------------------------
    def _search_inner(
        self,
        query: str,
        max_results: int,
        filter: dict[str, Any] | None,
        min_score: float | None,
    ) -> SearchResult | None:
        state = self._load_state()
        if state.root is None or state.stats.total_items == 0:
            # Empty store is a valid "no results" answer, not a failure.
            # Short-circuits before the embed call.
            return SearchResult(items=[], paths=[])

        try:
            query_emb = self._embedder.embed(query)
        except EmbedError as exc:
            logger.error("[contexto:local] embed query failed: %s", exc)
            return None

        result = beam_search(
            state.root,
            query_emb,
            self._config.mindmap,
            beam_width=self._config.beam_width,
            max_results=max_results,
            filter=filter,
            min_score=min_score,
        )

        # Spec §5 (retrieval) + TS ScoredQueryResult parity: each result is a
        # wrapper {"item": {...}, "score": float} so callers can rank or
        # threshold downstream. The engine's `_entry_id` and `format_search_results`
        # already accept this wrapped shape (and fall back to bare items), so
        # nothing on the consumer side changes.
        items_wire: list[dict[str, Any]] = []
        for scored in result.scored:
            item = scored.item
            items_wire.append({
                "item": {
                    "id": item.id,
                    "role": item.role,
                    "content": item.content,
                    "timestamp": item.timestamp,
                    "metadata": item.metadata,
                },
                "score": scored.score,
            })

        return SearchResult(items=items_wire, paths=result.paths)

    # ----- state ----------------------------------------------------------
    def _load_state(self) -> StoreState:
        if self._state is None:
            self._state = self._store.load()
        return self._state

    def _config_snapshot(self) -> dict[str, Any]:
        """Mindmap-shaping fields persisted alongside the tree. Per spec §8."""
        return {
            "embed_model": self._config.resolved_embed_model(),
            "llm_model": self._config.resolved_llm_model(),
            "provider": self._config.provider,
            "similarity_threshold": self._config.mindmap.similarity_threshold,
            "max_depth": self._config.mindmap.max_depth,
            "max_children": self._config.mindmap.max_children,
            "rebuild_interval": self._config.mindmap.rebuild_interval,
            "beam_width": self._config.beam_width,
        }
