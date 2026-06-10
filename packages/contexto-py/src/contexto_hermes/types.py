"""Dataclasses + env-var parsing for the Contexto Hermes plugin.

Plain dataclasses; no pydantic dependency. Env helpers never raise — registration
must succeed whenever CONTEXTO_API_KEY is set, regardless of other env-var hygiene.
"""

from __future__ import annotations

import logging
import math
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


def _env_int(
    key: str,
    default: int,
    *,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    """Parse an int env var. Returns default on missing/invalid/out-of-range, with WARNING."""
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        value = int(raw)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid integer for %s=%r; using default %s", key, raw, default
        )
        return default
    if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
        logger.warning(
            "Out-of-range integer for %s=%r (expected %s..%s); using default %s",
            key, raw, minimum, maximum, default,
        )
        return default
    return value


def _env_float(
    key: str,
    default: float,
    *,
    minimum: float | None = None,
    maximum: float | None = None,
) -> float:
    """Parse a float env var. Returns default on missing/invalid/out-of-range/NaN, with WARNING."""
    raw = os.environ.get(key)
    if raw is None:
        return default
    try:
        value = float(raw)
    except (TypeError, ValueError):
        logger.warning(
            "Invalid float for %s=%r; using default %s", key, raw, default
        )
        return default
    if not math.isfinite(value):
        logger.warning(
            "Non-finite float for %s=%r; using default %s", key, raw, default
        )
        return default
    if (minimum is not None and value < minimum) or (maximum is not None and value > maximum):
        logger.warning(
            "Out-of-range float for %s=%r (expected %s..%s); using default %s",
            key, raw, minimum, maximum, default,
        )
        return default
    return value


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
            max_context_chars=_env_int("CONTEXTO_MAX_CONTEXT_CHARS", default=2000, minimum=1),
            min_score=_env_float("CONTEXTO_MIN_SCORE", default=0.45, minimum=0.0, maximum=1.0),
            max_results=_env_int("CONTEXTO_MAX_RESULTS", default=7, minimum=1),
            search_timeout=_env_float("CONTEXTO_SEARCH_TIMEOUT", default=10.0, minimum=0.0),
            ingest_timeout=_env_float("CONTEXTO_INGEST_TIMEOUT", default=30.0, minimum=0.0),
        )

    @classmethod
    def local_mode_defaults(cls) -> "ContextoConfig":
        """ContextoConfig wired for local mode. CONTEXTO_API_KEY is not used.

        Tunables read CONTEXTO_* env vars where set (so `min_score`,
        `max_context_chars`, etc. still affect `compress()`).
        """
        return cls(
            api_key="",  # unused; LocalBackend uses provider-specific creds
            context_enabled=_env_bool("CONTEXTO_ENABLED", default=True),
            max_context_chars=_env_int("CONTEXTO_MAX_CONTEXT_CHARS", default=2000, minimum=1),
            # Lower than remote's 0.45: locally one summary spans a whole drop
            # slice, so query-to-summary cosine for a relevant hit often lands
            # in the 0.35–0.45 band.
            min_score=_env_float("CONTEXTO_MIN_SCORE", default=0.35, minimum=0.0, maximum=1.0),
            max_results=_env_int("CONTEXTO_MAX_RESULTS", default=7, minimum=1),
            search_timeout=_env_float("CONTEXTO_SEARCH_TIMEOUT", default=10.0, minimum=0.0),
            ingest_timeout=_env_float("CONTEXTO_INGEST_TIMEOUT", default=30.0, minimum=0.0),
        )


@dataclass
class ApiError:
    """Categorized error from RemoteBackend. Passed to engine via on_error callback."""

    category: str  # "auth" | "schema" | "ratelimit" | "server" | "network"
    message: str
    retry_after: float | None = None


@dataclass
class SearchResult:
    """Parsed mindmap-search response. Returned by both backends.

    `paths` is a list of cluster-label paths (not IDs) leading to each terminal
    node in beam search. Matches TS `ScoredQueryResult.paths`.
    """

    items: list[dict[str, Any]] = field(default_factory=list)
    paths: list[list[str]] = field(default_factory=list)
