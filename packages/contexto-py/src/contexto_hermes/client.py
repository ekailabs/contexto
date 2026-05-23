"""RemoteBackend — sync httpx client for api.getcontexto.com.

Mirrors TS RemoteBackend semantics (URLs, headers, body shapes) and adds
Python-side concerns the TS version doesn't have: configurable timeouts and
429 suppression with Retry-After.

Per-request client construction (`with httpx.Client(...) as c`). No
module-level shared state. Never raises — every failure path goes through
the `on_error` callback.

The engine observes errors via `on_error` and successes via `on_success`;
suppression state lives ONLY in the backend.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Callable

import httpx

from .types import ApiError, ContextoConfig, SearchResult, WebhookPayload

logger = logging.getLogger("plugins.context_engine.contexto")

API_BASE = "https://api.getcontexto.com"
INGEST_PATH = "/v1/webhooks/events"
SEARCH_PATH = "/v1/mindmap/search"


def _categorize_status(status: int) -> str:
    if status in (401, 403):
        return "auth"
    if status == 422:
        return "schema"
    if status == 429:
        return "ratelimit"
    return "server"


def _parse_retry_after(raw: str | None) -> float:
    if not raw:
        return 60.0  # conservative default
    raw = raw.strip()
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return 60.0  # HTTP-date form is rare; fall back to 60s


class RemoteBackend:
    """Sync HTTP backend talking to api.getcontexto.com."""

    def __init__(
        self,
        config: ContextoConfig,
        on_error: Callable[[ApiError], None],
        on_success: Callable[[], None],
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._config = config
        self._on_error = on_error
        self._on_success = on_success
        self._transport = transport
        self._headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {config.api_key}",
        }
        self._rate_limit_reset_at: float | None = None

    # --- public surface ---

    def ingest(self, payloads: list[WebhookPayload]) -> bool:
        if not payloads:
            return True
        if self._suppressed():
            return False
        try:
            with self._client(self._config.ingest_timeout) as client:
                response = client.post(
                    API_BASE + INGEST_PATH,
                    headers=self._headers,
                    json=payloads,
                )
        except httpx.HTTPError as exc:
            self._handle_network_error(exc)
            return False
        except Exception as exc:
            self._handle_unexpected_error(exc)
            return False

        return self._handle_response(response, op="ingest")

    def search(
        self,
        query: str,
        max_results: int,
        filter: dict[str, Any] | None,
        min_score: float,
    ) -> SearchResult | None:
        if self._suppressed():
            return None
        body: dict[str, Any] = {
            "query": query,
            "maxResults": max_results,
            "filter": filter,
            "minScore": min_score,
        }
        try:
            with self._client(self._config.search_timeout) as client:
                response = client.post(
                    API_BASE + SEARCH_PATH,
                    headers=self._headers,
                    json=body,
                )
        except httpx.HTTPError as exc:
            self._handle_network_error(exc)
            return None
        except Exception as exc:
            self._handle_unexpected_error(exc)
            return None

        if not self._handle_response(response, op="search"):
            return None

        try:
            data = response.json()
        except ValueError:
            logger.error("Search response was not valid JSON")
            return None
        if not isinstance(data, dict):
            logger.error("Search response JSON was not an object")
            return None
        items = data.get("items", [])
        paths = data.get("paths", [])
        return SearchResult(
            items=items if isinstance(items, list) else [],
            paths=paths if isinstance(paths, list) else [],
        )

    # --- internals ---

    def _client(self, timeout: float) -> httpx.Client:
        kwargs: dict[str, Any] = {"timeout": timeout}
        if self._transport is not None:
            kwargs["transport"] = self._transport
        return httpx.Client(**kwargs)

    def _suppressed(self) -> bool:
        if self._rate_limit_reset_at is None:
            return False
        if time.time() >= self._rate_limit_reset_at:
            self._rate_limit_reset_at = None
            return False
        return True

    def _handle_response(self, response: httpx.Response, *, op: str) -> bool:
        if response.is_success:
            self._on_success()
            return True

        category = _categorize_status(response.status_code)
        retry_after: float | None = None
        if category == "ratelimit":
            retry_after = _parse_retry_after(response.headers.get("Retry-After"))
            self._rate_limit_reset_at = time.time() + retry_after
            logger.warning(
                "[contexto] %s rate-limited (HTTP 429); suppressing for %.1fs",
                op, retry_after,
            )
        else:
            body_preview = ""
            try:
                body_preview = response.text[:200]
            except Exception:
                pass
            logger.error(
                "[contexto] %s HTTP %d: %s",
                op, response.status_code, body_preview,
            )

        self._on_error(ApiError(
            category=category,
            message=f"HTTP {response.status_code}",
            retry_after=retry_after,
        ))
        return False

    def _handle_network_error(self, exc: httpx.HTTPError) -> None:
        logger.error("[contexto] network error: %s", exc)
        self._on_error(ApiError(category="network", message=str(exc) or type(exc).__name__))

    def _handle_unexpected_error(self, exc: BaseException) -> None:
        logger.error("[contexto] unexpected error: %s", exc, exc_info=True)
        self._on_error(ApiError(category="network", message=str(exc) or type(exc).__name__))
