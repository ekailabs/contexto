"""Integration round-trip for LocalBackend — fake embedder/summarizer, real scipy."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pytest

from contexto_hermes.local.backend import LocalBackend
from contexto_hermes.local.mindmap_types import (
    EpisodeSummary,
    EvidenceRef,
    LocalBackendConfig,
    MindmapConfig,
)


def _payload(text: str, *, idx: int) -> dict:
    return {
        "event": {"type": "episode", "action": "combined"},
        "sessionKey": f"sess-{idx}",
        "timestamp": "2026-05-23T00:00:00.000Z",
        "context": {"sessionId": f"sess-{idx}"},
        "data": {"messages": [
            {"role": "user", "content": text},
            {"role": "assistant", "content": f"answered: {text}"},
        ]},
    }


class _DeterministicEmbedder:
    """Hash-based embedder. Texts with shared tokens get nearby vectors."""

    def __init__(self, dim: int = 32) -> None:
        self._dim = dim

    def embed(self, text: str) -> list[float]:
        words = text.lower().split()
        if not words:
            words = [""]
        vec = np.zeros(self._dim, dtype=np.float64)
        for w in words:
            h = hashlib.sha256(w.encode("utf-8")).digest()
            v = np.frombuffer(h[: self._dim], dtype=np.uint8).astype(np.float64)
            v = (v - 128.0) / 128.0
            vec += v
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            vec /= norm
        return vec.tolist()


class _StaticSummarizer:
    """Echoes its input text as the summary — so search-by-content works."""

    def summarize(self, text: str) -> EpisodeSummary:
        return EpisodeSummary(
            summary=text,
            key_findings=["fact"],
            status="complete",
            confidence=0.95,
            evidence_refs=[EvidenceRef(type="episode_ref", value="x")],
            open_questions=None,
        )


@pytest.fixture
def cfg(tmp_path) -> LocalBackendConfig:
    return LocalBackendConfig(
        storage_path=str(tmp_path / "mindmap.json"),
        provider="openai",
        api_key="sk-test",
        embed_model="text-embedding-3-small",
        llm_model="gpt-4o-mini",
        embed_base_url="https://api.openai.com/v1",
        llm_base_url="https://api.openai.com/v1",
        summarize=True,
        mindmap=MindmapConfig(similarity_threshold=0.4, rebuild_interval=20),
        beam_width=3,
        embed_timeout=5.0,
        llm_timeout=10.0,
    )


def _make_backend(cfg: LocalBackendConfig) -> LocalBackend:
    return LocalBackend(cfg, embedder=_DeterministicEmbedder(), summarizer=_StaticSummarizer())


class TestRoundTrip:
    def test_40_then_20_episodes(self, cfg):
        backend = _make_backend(cfg)
        # First batch — 40 items, total < 100 forces rebuild.
        batch1 = [
            _payload(f"deployment failed in cluster {i}", idx=i) for i in range(20)
        ] + [
            _payload(f"weather sunny today {i}", idx=100 + i) for i in range(20)
        ]
        assert backend.ingest(batch1) is True

        from contexto_hermes.local.store import Store
        state = Store(cfg.storage_path).load()
        assert state.stats.total_items == 40
        assert state.stats.inserts_since_rebuild == 0  # rebuilt

        # Search — items with overlapping tokens should rank highest.
        result = backend.search("deployment failed", max_results=5)
        assert result is not None
        # Top result should match the deployment-shaped texts.
        top_contents = " ".join(e["item"]["content"] for e in result.items[:3]).lower()
        assert "deployment" in top_contents

        # Second batch — total goes to 60, still < 100 → rebuild on every add.
        batch2 = [_payload(f"hiking trip {i}", idx=200 + i) for i in range(20)]
        assert backend.ingest(batch2) is True
        state = Store(cfg.storage_path).load()
        assert state.stats.total_items == 60

    def test_reinstantiate_against_same_path_reloads_stats(self, cfg):
        backend = _make_backend(cfg)
        backend.ingest([_payload(f"hello {i}", idx=i) for i in range(5)])
        # Throw away the backend; new instance against same path picks up the state.
        backend2 = _make_backend(cfg)
        # Searching forces a load.
        result = backend2.search("hello", max_results=5)
        assert result is not None
        assert len(result.items) == 5

    def test_persisted_disk_schema(self, cfg):
        backend = _make_backend(cfg)
        backend.ingest([_payload(f"text {i}", idx=i) for i in range(3)])
        raw = json.loads(Path(cfg.storage_path).read_text())
        assert raw["version"] == 1
        assert raw["stats"]["total_items"] == 3
        assert raw["root"] is not None


class TestEmptyStoreGuard:
    def test_empty_store_returns_empty_result(self, cfg):
        # Patch beam_search to raise; the empty-store guard must short-circuit
        # before retrieval is invoked, returning empty results (not None —
        # that's reserved for failures).
        backend = _make_backend(cfg)
        import contexto_hermes.local.backend as mod
        original = mod.beam_search

        def boom(*a, **kw):
            raise AssertionError("beam_search should not be called on empty store")

        mod.beam_search = boom
        try:
            result = backend.search("anything", max_results=5)
            assert result is not None
            assert result.items == [] and result.paths == []
        finally:
            mod.beam_search = original
