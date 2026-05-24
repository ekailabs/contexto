"""Tests for contexto_hermes.tools — contexto_search schema + handler."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

import pytest

from contexto_hermes.tools import CONTEXTO_SEARCH_SCHEMA, contexto_search
from contexto_hermes.types import ContextoConfig, SearchResult


class StubBackend:
    def __init__(self, result: SearchResult | None = None) -> None:
        self._result = result
        self.calls: list[dict[str, Any]] = []

    def search(self, query, max_results, filter, min_score):
        self.calls.append({
            "query": query, "max_results": max_results,
            "filter": filter, "min_score": min_score,
        })
        return self._result


@dataclass
class StubEngine:
    config: ContextoConfig
    client: Any
    injected_item_ids: set[str] = field(default_factory=set)


def _engine(result: SearchResult | None, **cfg_overrides) -> tuple[StubEngine, StubBackend]:
    base = {
        "api_key": "ckai_test",
        "context_enabled": True,
        "max_context_chars": 2000,
        "min_score": 0.45,
        "max_results": 7,
        "search_timeout": 10.0,
        "ingest_timeout": 30.0,
    }
    base.update(cfg_overrides)
    cfg = ContextoConfig(**base)
    backend = StubBackend(result)
    return StubEngine(config=cfg, client=backend), backend


class TestSchema:
    def test_name(self) -> None:
        assert CONTEXTO_SEARCH_SCHEMA["name"] == "contexto_search"

    def test_description_mentions_recall(self) -> None:
        desc = CONTEXTO_SEARCH_SCHEMA["description"]
        assert "recall" in desc.lower()
        assert "constraint" in desc.lower() or "earlier" in desc.lower()

    def test_required_query(self) -> None:
        params = CONTEXTO_SEARCH_SCHEMA["parameters"]
        assert params["type"] == "object"
        assert "query" in params["properties"]
        assert params["properties"]["query"]["type"] == "string"
        assert "query" in params["required"]

    def test_max_results_optional_with_default(self) -> None:
        params = CONTEXTO_SEARCH_SCHEMA["parameters"]
        assert "max_results" in params["properties"]
        assert params["properties"]["max_results"]["type"] == "integer"
        assert params["properties"]["max_results"]["default"] == 5


class TestSearchInvocation:
    def test_calls_backend_with_summary_filter_and_engine_min_score(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]), min_score=0.6)
        contexto_search(engine, {"query": "hello"})
        assert len(backend.calls) == 1
        call = backend.calls[0]
        assert call["query"] == "hello"
        assert call["filter"] == {"source": "summary"}
        assert call["min_score"] == 0.6

    def test_default_max_results_from_schema(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        contexto_search(engine, {"query": "x"})
        assert backend.calls[0]["max_results"] == 5

    def test_explicit_max_results_overrides(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        contexto_search(engine, {"query": "x", "max_results": 12})
        assert backend.calls[0]["max_results"] == 12


class TestResultShape:
    def test_returns_json_string(self) -> None:
        engine, _ = _engine(SearchResult(items=[], paths=[]))
        result = contexto_search(engine, {"query": "x"})
        assert isinstance(result, str)
        parsed = json.loads(result)
        assert "context" in parsed
        assert "items" in parsed
        assert "paths" in parsed

    def test_empty_results_returns_empty_arrays(self) -> None:
        engine, _ = _engine(SearchResult(items=[], paths=[]))
        result = contexto_search(engine, {"query": "x"})
        parsed = json.loads(result)
        assert parsed["context"] == ""
        assert parsed["items"] == []
        assert parsed["paths"] == []

    def test_returns_formatted_context_items_and_paths(self) -> None:
        items = [
            {"item": {"id": "i1", "content": "hi", "metadata": {"source": "summary"}}},
            {"item": {"id": "i2", "content": "ho", "metadata": {"source": "raw"}}},
        ]
        paths = [{"id": "p1"}]
        engine, _ = _engine(SearchResult(items=items, paths=paths))
        result = contexto_search(engine, {"query": "x"})
        parsed = json.loads(result)
        assert parsed["context"] == "## Relevant Context\n\nhi\n\n- ho"
        assert parsed["items"] == items
        assert parsed["paths"] == paths

    def test_formatted_context_honors_max_context_chars(self) -> None:
        items = [{"item": {"id": "i1", "content": "x" * 200}}]
        engine, _ = _engine(SearchResult(items=items, paths=[]), max_context_chars=40)
        result = contexto_search(engine, {"query": "x"})
        parsed = json.loads(result)
        assert len(parsed["context"]) == 41
        assert parsed["context"].endswith("…")

    def test_zero_max_context_chars_does_not_collapse_to_ellipsis(self) -> None:
        # Guard against a degenerate cap (e.g. directly constructed config): the
        # context must not collapse to just "…" — truncation is skipped instead.
        items = [{"item": {"id": "i1", "content": "real recalled content"}}]
        engine, _ = _engine(SearchResult(items=items, paths=[]), max_context_chars=0)
        result = contexto_search(engine, {"query": "x"})
        parsed = json.loads(result)
        assert parsed["context"] != "…"
        assert "real recalled content" in parsed["context"]


class TestDedup:
    def test_filters_already_injected_ids(self) -> None:
        items = [
            {"item": {"id": "a", "content": "ax"}},
            {"item": {"id": "b", "content": "bx"}},
            {"item": {"id": "c", "content": "cx"}},
        ]
        engine, _ = _engine(SearchResult(items=items, paths=[]))
        engine.injected_item_ids.add("b")
        result = contexto_search(engine, {"query": "x"})
        parsed = json.loads(result)
        ids = [r["item"]["id"] for r in parsed["items"]]
        assert "b" not in ids
        assert "a" in ids
        assert "c" in ids

    def test_dedup_handles_top_level_id(self) -> None:
        # Some items may not be wrapped in {item: ...}
        items = [
            {"id": "a", "content": "ax"},
            {"id": "b", "content": "bx"},
        ]
        engine, _ = _engine(SearchResult(items=items, paths=[]))
        engine.injected_item_ids.add("a")
        result = contexto_search(engine, {"query": "x"})
        parsed = json.loads(result)
        ids = [r.get("id") or r.get("item", {}).get("id") for r in parsed["items"]]
        assert "a" not in ids
        assert "b" in ids

    def test_returned_ids_are_recorded_for_future_dedup(self) -> None:
        # Per spec §5: injected_item_ids dedups across compactions AND tool calls.
        items = [
            {"item": {"id": "x1", "content": "fact 1"}},
            {"item": {"id": "x2", "content": "fact 2"}},
        ]
        engine, _ = _engine(SearchResult(items=items, paths=[]))
        contexto_search(engine, {"query": "q"})
        assert engine.injected_item_ids == {"x1", "x2"}

    def test_recorded_ids_persist_across_tool_calls(self) -> None:
        first_items = [{"item": {"id": "a", "content": "first"}}]
        engine, backend = _engine(SearchResult(items=first_items, paths=[]))
        contexto_search(engine, {"query": "q1"})
        assert engine.injected_item_ids == {"a"}

        # Next call returns a + b; only b should appear, but both should be in the set.
        backend._result = SearchResult(  # type: ignore[attr-defined]
            items=[
                {"item": {"id": "a", "content": "first"}},
                {"item": {"id": "b", "content": "second"}},
            ],
            paths=[],
        )
        result = contexto_search(engine, {"query": "q2"})
        parsed = json.loads(result)
        ids = [r["item"]["id"] for r in parsed["items"]]
        assert ids == ["b"]
        assert engine.injected_item_ids == {"a", "b"}

    def test_items_without_id_not_recorded(self) -> None:
        items = [
            {"item": {"content": "no-id-here"}},
            {"item": {"id": "has-id", "content": "yes"}},
        ]
        engine, _ = _engine(SearchResult(items=items, paths=[]))
        contexto_search(engine, {"query": "q"})
        assert engine.injected_item_ids == {"has-id"}

    def test_degraded_path_does_not_record(self) -> None:
        engine, _ = _engine(None)
        contexto_search(engine, {"query": "q"})
        assert engine.injected_item_ids == set()


class TestMalformedArgs:
    """LLM tool args are not fully trustworthy — handler must fail-soft."""

    def test_max_results_null_uses_default(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        result = contexto_search(engine, {"query": "x", "max_results": None})
        json.loads(result)  # must not raise
        assert backend.calls[0]["max_results"] == 5  # schema default

    def test_max_results_string_uses_default(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        result = contexto_search(engine, {"query": "x", "max_results": "many"})
        json.loads(result)
        assert backend.calls[0]["max_results"] == 5

    def test_max_results_numeric_string_parsed(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        contexto_search(engine, {"query": "x", "max_results": "8"})
        assert backend.calls[0]["max_results"] == 8

    def test_max_results_zero_clamped_to_one(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        contexto_search(engine, {"query": "x", "max_results": 0})
        assert backend.calls[0]["max_results"] == 1

    def test_max_results_negative_clamped_to_one(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        contexto_search(engine, {"query": "x", "max_results": -5})
        assert backend.calls[0]["max_results"] == 1

    def test_max_results_huge_clamped(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        contexto_search(engine, {"query": "x", "max_results": 10_000})
        # Clamped to a reasonable cap
        assert backend.calls[0]["max_results"] <= 50

    def test_query_null_returns_degraded(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        result = contexto_search(engine, {"query": None})
        parsed = json.loads(result)
        # Must not raise; no backend call when query is unusable
        assert parsed["items"] == []
        assert backend.calls == []

    def test_query_missing_returns_degraded(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        result = contexto_search(engine, {})
        parsed = json.loads(result)
        assert parsed["items"] == []
        assert backend.calls == []

    def test_query_non_string_coerced_or_rejected(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        # An LLM might emit a number or object. Either coerce or treat as empty,
        # but MUST NOT raise.
        result = contexto_search(engine, {"query": 42})
        json.loads(result)
        # If coerced, we'd send "42"; if rejected, we'd skip. Either is acceptable.
        if backend.calls:
            assert backend.calls[0]["query"] == "42"

    def test_args_not_a_dict_returns_degraded(self) -> None:
        engine, backend = _engine(SearchResult(items=[], paths=[]))
        # Defensive: model occasionally emits malformed JSON that ends up as
        # a non-dict. Handler must not raise.
        result = contexto_search(engine, None)  # type: ignore[arg-type]
        parsed = json.loads(result)
        assert parsed["items"] == []
        assert backend.calls == []


class TestFailSoft:
    def test_backend_none_returns_degraded_json(self) -> None:
        engine, _ = _engine(None)
        result = contexto_search(engine, {"query": "x"})
        parsed = json.loads(result)
        # Doesn't raise; returns sensible empty payload with a note
        assert parsed["items"] == []
        assert parsed["paths"] == []
        assert "status" in parsed or "error" in parsed or "note" in parsed
