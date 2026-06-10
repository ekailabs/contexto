"""Tests for LocalBackend — orchestration + error contract."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from typing import Any

import numpy as np
import pytest

from contexto_hermes.local.backend import LocalBackend
from contexto_hermes.local.embedder import EmbedError
from contexto_hermes.local.mindmap_types import (
    EpisodeSummary,
    EvidenceRef,
    LocalBackendConfig,
    MindmapConfig,
)
from contexto_hermes.local.store import Store


def _payload(text: str, *, session_key: str = "sess-1") -> dict:
    return {
        "event": {"type": "episode", "action": "combined"},
        "sessionKey": session_key,
        "timestamp": "2026-05-23T00:00:00.000Z",
        "context": {"sessionId": "s"},
        "data": {"messages": [
            {"role": "user", "content": text},
            {"role": "assistant", "content": f"answered: {text}"},
        ]},
    }


def _normalize(v: list[float]) -> list[float]:
    arr = np.asarray(v, dtype=np.float64)
    n = float(np.linalg.norm(arr))
    return (arr / n).tolist() if n > 0 else v


class FakeEmbedder:
    """Deterministic embedder: hash bytes → small float vector."""

    def __init__(self, dim: int = 8, fail: bool = False):
        self._dim = dim
        self._fail = fail

    def embed(self, text: str) -> list[float]:
        if self._fail:
            raise EmbedError("fake embed failure")
        # Very simple hash-based mapping so similar text → similar vectors.
        import hashlib
        h = hashlib.sha256(text.encode("utf-8")).digest()
        vec = [(h[i] - 128) / 128.0 for i in range(self._dim)]
        return _normalize(vec)


class FakeSummarizer:
    def __init__(self, status: str = "complete", confidence: float = 0.9):
        self._status = status
        self._confidence = confidence

    def summarize(self, text: str) -> EpisodeSummary:
        return EpisodeSummary(
            summary=f"summary of: {text[:60]}",
            key_findings=["fact-1", "fact-2"],
            status=self._status,
            confidence=self._confidence,
            evidence_refs=[EvidenceRef(type="episode_ref", value="ep1")],
            open_questions=None,
        )


def _make_backend(config: LocalBackendConfig, *, embed_fail=False, summarizer=None) -> LocalBackend:
    return LocalBackend(
        config,
        embedder=FakeEmbedder(fail=embed_fail),
        summarizer=summarizer or FakeSummarizer(),
    )


class TestIngestHappyPath:
    def test_round_trip(self, base_config):
        backend = _make_backend(base_config)
        ok = backend.ingest([_payload("hello world")])
        assert ok is True

        result = backend.search("hello", max_results=5)
        assert result is not None
        assert len(result.items) == 1
        entry = result.items[0]
        # Spec §5 / TS parity: each result is a {"item": ..., "score": ...} wrapper.
        assert "item" in entry and "score" in entry
        assert isinstance(entry["score"], float)
        item = entry["item"]
        # FakeSummarizer.summary echoes the extractor output (`Q: hello world\n...`).
        assert item["content"].startswith("summary of: Q: hello world")
        assert item["metadata"]["source"] == "summary"
        assert item["metadata"]["status"] == "complete"
        assert item["metadata"]["confidence"] == 0.9
        assert item["metadata"]["evidence_refs"] == [{"type": "episode_ref", "value": "ep1"}]
        assert item["metadata"]["sessionKey"] == "sess-1"
        assert "trace_ref" in item["metadata"]
        assert "extracted_text" in item["metadata"]["episode"]

    def test_persists_to_disk(self, base_config):
        backend = _make_backend(base_config)
        backend.ingest([_payload("episode A")])
        # File exists.
        from pathlib import Path
        path = Path(base_config.storage_path)
        assert path.exists()
        data = json.loads(path.read_text())
        assert data["version"] == 1
        assert data["stats"]["total_items"] == 1

    def test_config_snapshot_populated(self, base_config):
        # Spec §8 + F8: every save records the mindmap-shaping tunables.
        backend = _make_backend(base_config)
        backend.ingest([_payload("episode A")])
        from pathlib import Path
        snapshot = json.loads(Path(base_config.storage_path).read_text())["config_snapshot"]
        # Resolved (not None) — defaults swapped in.
        assert snapshot["embed_model"] == "text-embedding-3-small"
        assert snapshot["llm_model"] == "gpt-4o-mini"
        assert snapshot["provider"] == "openai"
        assert snapshot["similarity_threshold"] == 0.65
        assert snapshot["rebuild_interval"] == 50
        assert snapshot["max_depth"] == 4
        assert snapshot["beam_width"] == 3

    def test_synthetic_summary_when_disabled(self, base_config):
        base_config.summarize = False
        backend = LocalBackend(base_config, embedder=FakeEmbedder(), summarizer=None)
        # summarizer instantiated by ctor but never called.
        ok = backend.ingest([_payload("hi")])
        assert ok is True
        result = backend.search("hi", max_results=5)
        assert result is not None
        assert "summarization disabled" in result.items[0]["item"]["content"]


class TestIngestFiltering:
    def test_non_episode_events_filtered(self, base_config):
        backend = _make_backend(base_config)
        non_ep = {
            "event": {"type": "metric", "action": "snapshot"},
            "data": {"messages": []},
        }
        ok = backend.ingest([non_ep])
        assert ok is True  # graceful no-op
        # Nothing persisted.
        from pathlib import Path
        assert not Path(base_config.storage_path).exists()

    def test_empty_episode_text_skipped(self, base_config):
        backend = _make_backend(base_config)
        empty = {
            "event": {"type": "episode", "action": "combined"},
            "sessionKey": "s",
            "data": {"messages": [{"role": "system", "content": "x"}]},
        }
        ok = backend.ingest([empty])
        assert ok is True
        # No item recorded.
        from pathlib import Path
        assert not Path(base_config.storage_path).exists()


class TestNeverRaisesContract:
    def test_embed_failure_returns_False(self, base_config):
        backend = _make_backend(base_config, embed_fail=True)
        assert backend.ingest([_payload("x")]) is False

    def test_search_on_empty_store_returns_empty_result(self, base_config):
        # Empty store is "no results", not a failure — None is reserved for errors.
        backend = _make_backend(base_config)
        result = backend.search("anything", max_results=5)
        assert result is not None
        assert result.items == [] and result.paths == []

    def test_search_embed_failure_returns_None(self, base_config):
        # Ingest with working embedder, then swap to a failing embedder for search.
        backend = _make_backend(base_config)
        backend.ingest([_payload("x")])
        backend._embedder = FakeEmbedder(fail=True)
        assert backend.search("q", max_results=5) is None

    def test_store_write_failure_returns_False(self, base_config, monkeypatch):
        backend = _make_backend(base_config)

        def raise_on_save(self, state):
            raise OSError("disk full")
        monkeypatch.setattr(Store, "save", raise_on_save)
        assert backend.ingest([_payload("x")]) is False

    def test_clustering_failure_returns_False(self, base_config, monkeypatch):
        backend = _make_backend(base_config)
        # Force the embedder to return non-finite values; clustering must reject.
        class BrokenEmbedder:
            def embed(self, text: str) -> list[float]:
                return [float("nan"), 0.0, 0.0]
        backend._embedder = BrokenEmbedder()
        # Need 2+ items to trigger scipy.linkage (rebuild < 100 always rebuilds).
        ok = backend.ingest([_payload("a"), _payload("b")])
        assert ok is False

    def test_unexpected_exception_returns_False(self, base_config, monkeypatch):
        backend = _make_backend(base_config)

        class Boom:
            def embed(self, text):
                raise RuntimeError("synthetic boom")

        backend._embedder = Boom()
        # Should not raise.
        assert backend.ingest([_payload("x")]) is False

    def test_search_unexpected_exception_returns_None(self, base_config, monkeypatch):
        backend = _make_backend(base_config)
        backend.ingest([_payload("x")])

        # Now monkey-patch beam_search via the module to raise.
        import contexto_hermes.local.backend as mod
        monkeypatch.setattr(mod, "beam_search", lambda *a, **kw: (_ for _ in ()).throw(RuntimeError("boom")))
        assert backend.search("q", max_results=5) is None


class TestSearchShape:
    def test_paths_are_lists_of_strings(self, base_config):
        backend = _make_backend(base_config)
        backend.ingest([_payload(f"episode {i}") for i in range(3)])
        result = backend.search("episode 0", max_results=3)
        assert result is not None
        assert isinstance(result.paths, list)
        for p in result.paths:
            assert isinstance(p, list)
            for label in p:
                assert isinstance(label, str)

    def test_items_are_wrapped_with_score(self, base_config):
        backend = _make_backend(base_config)
        backend.ingest([_payload(f"episode {i}") for i in range(3)])
        result = backend.search("episode 0", max_results=3)
        assert result is not None
        for entry in result.items:
            assert set(entry.keys()) == {"item", "score"}
            assert isinstance(entry["score"], float)
            assert "id" in entry["item"] and "content" in entry["item"]
        # Scores are non-ascending.
        scores = [e["score"] for e in result.items]
        assert scores == sorted(scores, reverse=True)

    def test_empty_result_when_no_results_pass_filter(self, base_config):
        backend = _make_backend(base_config)
        backend.ingest([_payload("hi")])
        # Filter on metadata that doesn't exist — no matches, but not a failure.
        result = backend.search("hi", max_results=5, filter={"source": "raw"})
        assert result is not None
        assert result.items == []
