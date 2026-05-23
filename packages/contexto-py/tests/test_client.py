"""Tests for contexto_hermes.client — RemoteBackend with httpx.MockTransport."""

from __future__ import annotations

import json
import time
from typing import Callable

import httpx
import pytest

from contexto_hermes.client import RemoteBackend
from contexto_hermes.types import ApiError, ContextoConfig


def _config(**overrides) -> ContextoConfig:
    base = {
        "api_key": "ckai_test",
        "context_enabled": True,
        "max_context_chars": 2000,
        "min_score": 0.45,
        "max_results": 7,
        "search_timeout": 10.0,
        "ingest_timeout": 30.0,
    }
    base.update(overrides)
    return ContextoConfig(**base)


def _make_backend(
    handler: Callable[[httpx.Request], httpx.Response],
    on_error_list: list[ApiError] | None = None,
    on_success_count: list[int] | None = None,
    **config_overrides,
) -> RemoteBackend:
    cfg = _config(**config_overrides)
    on_error_list = on_error_list if on_error_list is not None else []
    on_success_count = on_success_count if on_success_count is not None else [0]

    def on_error(err: ApiError) -> None:
        on_error_list.append(err)

    def on_success() -> None:
        on_success_count[0] += 1

    transport = httpx.MockTransport(handler)
    backend = RemoteBackend(cfg, on_error=on_error, on_success=on_success, transport=transport)
    return backend


class TestIngest:
    def test_url_and_headers(self) -> None:
        captured: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(200, json={"ok": True})

        backend = _make_backend(handler)
        assert backend.ingest([{"hello": "world"}]) is True
        req = captured[0]
        assert str(req.url) == "https://api.getcontexto.com/v1/webhooks/events"
        assert req.method == "POST"
        assert req.headers["authorization"] == "Bearer ckai_test"
        assert req.headers["content-type"].startswith("application/json")

    def test_body_is_raw_payload_array(self) -> None:
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(200, json={"ok": True})

        backend = _make_backend(handler)
        payloads = [{"a": 1}, {"b": 2}]
        backend.ingest(payloads)
        body = json.loads(captured[0])
        # MUST be a raw array, NOT wrapped in {"events": [...]}.
        assert isinstance(body, list)
        assert body == payloads

    def test_empty_payload_list_is_noop(self) -> None:
        called = [False]

        def handler(req: httpx.Request) -> httpx.Response:
            called[0] = True
            return httpx.Response(200)

        backend = _make_backend(handler)
        assert backend.ingest([]) is True
        assert called[0] is False

    def test_2xx_fires_on_success(self) -> None:
        success_count = [0]
        errors: list[ApiError] = []

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"ok": True})

        backend = _make_backend(handler, on_error_list=errors, on_success_count=success_count)
        assert backend.ingest([{"x": 1}]) is True
        assert success_count[0] == 1
        assert errors == []

    @pytest.mark.parametrize("status,expected_category", [
        (401, "auth"),
        (403, "auth"),
        (422, "schema"),
        (500, "server"),
        (502, "server"),
        (503, "server"),
    ])
    def test_http_error_categories(self, status: int, expected_category: str) -> None:
        errors: list[ApiError] = []

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(status, json={"error": "fail"})

        backend = _make_backend(handler, on_error_list=errors)
        assert backend.ingest([{"x": 1}]) is False
        assert len(errors) == 1
        assert errors[0].category == expected_category

    def test_429_sets_suppression_and_categorizes_ratelimit(self) -> None:
        errors: list[ApiError] = []

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(429, headers={"Retry-After": "30"}, json={"error": "slow down"})

        backend = _make_backend(handler, on_error_list=errors)
        assert backend.ingest([{"x": 1}]) is False
        assert errors[0].category == "ratelimit"
        assert errors[0].retry_after == 30.0
        assert backend._rate_limit_reset_at is not None
        assert backend._rate_limit_reset_at > time.time()

    def test_subsequent_calls_during_suppression_window(self) -> None:
        errors: list[ApiError] = []
        call_count = [0]

        def handler(req: httpx.Request) -> httpx.Response:
            call_count[0] += 1
            return httpx.Response(429, headers={"Retry-After": "30"}, json={"error": "slow down"})

        backend = _make_backend(handler, on_error_list=errors)
        backend.ingest([{"x": 1}])  # trips suppression
        assert call_count[0] == 1
        assert len(errors) == 1

        # Subsequent call during the window: no HTTP request, no new on_error
        result = backend.ingest([{"x": 2}])
        assert result is False
        assert call_count[0] == 1
        assert len(errors) == 1

    def test_suppression_expires_then_call_proceeds(self) -> None:
        errors: list[ApiError] = []
        call_count = [0]

        def handler(req: httpx.Request) -> httpx.Response:
            call_count[0] += 1
            return httpx.Response(200, json={"ok": True})

        backend = _make_backend(handler, on_error_list=errors)
        backend._rate_limit_reset_at = time.time() - 1  # expired
        result = backend.ingest([{"x": 1}])
        assert result is True
        assert call_count[0] == 1
        assert backend._rate_limit_reset_at is None  # cleared

    def test_network_error_categorized(self) -> None:
        errors: list[ApiError] = []

        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        backend = _make_backend(handler, on_error_list=errors)
        assert backend.ingest([{"x": 1}]) is False
        assert errors[0].category == "network"

    def test_timeout_categorized_as_network(self) -> None:
        errors: list[ApiError] = []

        def handler(req: httpx.Request) -> httpx.Response:
            raise httpx.TimeoutException("timed out")

        backend = _make_backend(handler, on_error_list=errors)
        assert backend.ingest([{"x": 1}]) is False
        assert errors[0].category == "network"

    def test_never_raises_on_any_error(self) -> None:
        errors: list[ApiError] = []

        def handler(req: httpx.Request) -> httpx.Response:
            raise RuntimeError("unexpected")

        backend = _make_backend(handler, on_error_list=errors)
        # Must not propagate
        backend.ingest([{"x": 1}])
        assert len(errors) == 1


class TestSearch:
    def test_url_and_method(self) -> None:
        captured: list[httpx.Request] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req)
            return httpx.Response(200, json={"items": [], "paths": []})

        backend = _make_backend(handler)
        result = backend.search("hello", max_results=5, filter={"source": "summary"}, min_score=0.5)
        assert result is not None
        assert str(captured[0].url) == "https://api.getcontexto.com/v1/mindmap/search"
        assert captured[0].method == "POST"

    def test_body_uses_ts_camelcase_wire_format(self) -> None:
        captured: list[bytes] = []

        def handler(req: httpx.Request) -> httpx.Response:
            captured.append(req.content)
            return httpx.Response(200, json={"items": [], "paths": []})

        backend = _make_backend(handler)
        backend.search("what's up", max_results=7, filter={"source": "summary"}, min_score=0.45)
        body = json.loads(captured[0])
        # MUST be camelCase, not snake_case.
        assert body["query"] == "what's up"
        assert body["maxResults"] == 7
        assert body["filter"] == {"source": "summary"}
        assert body["minScore"] == 0.45
        assert "max_results" not in body
        assert "min_score" not in body

    def test_parses_2xx_response(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={
                "items": [{"item": {"content": "hi"}}],
                "paths": [{"id": "p1"}],
            })

        backend = _make_backend(handler)
        result = backend.search("q", max_results=5, filter=None, min_score=0.1)
        assert result is not None
        assert result.items == [{"item": {"content": "hi"}}]
        assert result.paths == [{"id": "p1"}]

    def test_returns_none_on_error(self) -> None:
        errors: list[ApiError] = []

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(500, json={"err": "boom"})

        backend = _make_backend(handler, on_error_list=errors)
        result = backend.search("q", max_results=5, filter=None, min_score=0.1)
        assert result is None
        assert errors[0].category == "server"

    def test_search_honors_suppression(self) -> None:
        errors: list[ApiError] = []
        call_count = [0]

        def handler(req: httpx.Request) -> httpx.Response:
            call_count[0] += 1
            return httpx.Response(429, headers={"Retry-After": "10"}, json={})

        backend = _make_backend(handler, on_error_list=errors)
        backend.search("q", max_results=5, filter=None, min_score=0.1)
        assert call_count[0] == 1
        # Suppressed
        assert backend.search("q2", max_results=5, filter=None, min_score=0.1) is None
        assert call_count[0] == 1
        assert len(errors) == 1

    def test_search_2xx_fires_on_success(self) -> None:
        success_count = [0]

        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"items": [], "paths": []})

        backend = _make_backend(handler, on_success_count=success_count)
        backend.search("q", max_results=5, filter=None, min_score=0.1)
        assert success_count[0] == 1

    @pytest.mark.parametrize("body", [
        [],
        "not an object",
        42,
        None,
    ])
    def test_non_object_2xx_response_returns_none(self, body) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=body)

        backend = _make_backend(handler)
        assert backend.search("q", max_results=5, filter=None, min_score=0.1) is None

    def test_malformed_items_and_paths_default_to_empty_lists(self) -> None:
        def handler(req: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json={"items": "bad", "paths": {"bad": True}})

        backend = _make_backend(handler)
        result = backend.search("q", max_results=5, filter=None, min_score=0.1)
        assert result is not None
        assert result.items == []
        assert result.paths == []


class TestTimeouts:
    def test_search_uses_search_timeout(self) -> None:
        captured: list[float | None] = []

        def handler(req: httpx.Request) -> httpx.Response:
            extensions = req.extensions or {}
            timeout = extensions.get("timeout") or {}
            captured.append(timeout.get("connect"))
            return httpx.Response(200, json={"items": [], "paths": []})

        backend = _make_backend(handler, search_timeout=4.0)
        backend.search("q", max_results=5, filter=None, min_score=0.1)
        # All timeout dimensions should be 4.0
        assert captured[0] == 4.0

    def test_ingest_uses_ingest_timeout(self) -> None:
        captured: list[float | None] = []

        def handler(req: httpx.Request) -> httpx.Response:
            extensions = req.extensions or {}
            timeout = extensions.get("timeout") or {}
            captured.append(timeout.get("connect"))
            return httpx.Response(200, json={"ok": True})

        backend = _make_backend(handler, ingest_timeout=20.0)
        backend.ingest([{"x": 1}])
        assert captured[0] == 20.0
