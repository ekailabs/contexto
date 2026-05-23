"""Dataclasses + env-var parsing for the Contexto Hermes plugin.

Plain dataclasses; no pydantic dependency. Env helpers never raise — registration
must succeed whenever CONTEXTO_API_KEY is set, regardless of other env-var hygiene.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, TypeAlias

logger = logging.getLogger("plugins.context_engine.contexto")

WebhookPayload: TypeAlias = dict[str, Any]


_TRUE_VALUES = {"true", "1", "yes", "on"}
_FALSE_VALUES = {"false", "0", "no", "off"}


def _env_bool(key: str, default: bool) -> bool:
    """Parse a boolean env var. Returns default on missing/invalid, with WARNING."""
    raw = os.environ.get(key)
    if raw is None:
        return default
    lowered = raw.strip().lower()
    if lowered in _TRUE_VALUES:
        return True
    if lowered in _FALSE_VALUES:
        return False
    logger.warning(
        "Invalid boolean for %s=%r; using default %s", key, raw, default
    )
    return default


def _env_int(key: str, default: int) -> int:
    """Parse an int env var. Returns default on missing/invalid, with WARNING."""
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        return int(raw)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid integer for %s=%r; using default %s", key, raw, default
        )
        return default


def _env_float(key: str, default: float) -> float:
    """Parse a float env var. Returns default on missing/invalid, with WARNING."""
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        return float(raw)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid float for %s=%r; using default %s", key, raw, default
        )
        return default


@dataclass
class ContextoConfig:
    """Runtime configuration. All fields except api_key have defaults."""

    api_key: str
    context_enabled: bool = True
    max_context_chars: int = 2000
    min_score: float = 0.45
    max_results: int = 7
    search_timeout: float = 10.0
    ingest_timeout: float = 30.0

    @classmethod
    def from_env(cls) -> "ContextoConfig | None":
        """Read CONTEXTO_* env vars. Returns None iff CONTEXTO_API_KEY is unset/empty."""
        api_key = os.environ.get("CONTEXTO_API_KEY", "").strip()
        if not api_key:
            return None
        return cls(
            api_key=api_key,
            context_enabled=_env_bool("CONTEXTO_ENABLED", default=True),
            max_context_chars=_env_int("CONTEXTO_MAX_CONTEXT_CHARS", default=2000),
            min_score=_env_float("CONTEXTO_MIN_SCORE", default=0.45),
            max_results=_env_int("CONTEXTO_MAX_RESULTS", default=7),
            search_timeout=_env_float("CONTEXTO_SEARCH_TIMEOUT", default=10.0),
            ingest_timeout=_env_float("CONTEXTO_INGEST_TIMEOUT", default=30.0),
        )


@dataclass
class ApiError:
    """Categorized error from RemoteBackend. Passed to engine via on_error callback."""

    category: str  # "auth" | "schema" | "ratelimit" | "server" | "network"
    message: str
    retry_after: float | None = None


@dataclass
class SearchResult:
    """Parsed /v1/mindmap/search response."""

    items: list[dict[str, Any]] = field(default_factory=list)
    paths: list[dict[str, Any]] = field(default_factory=list)
