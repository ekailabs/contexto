"""contexto-hermes — Contexto context engine plugin for hermes-agent.

Plugin entry point. Hermes' `_EngineCollector` exec's this module and calls
`register(ctx)`; we wire a `ContextoEngine` instance into `ctx`.
"""

from __future__ import annotations

import logging
from typing import Any

from .engine import ContextoEngine

__all__ = ["ContextoEngine", "register", "__compatible_contexto_api__"]
__version__ = "0.1.0"

# Pinned `api.getcontexto.com` schema version compatible with this release.
# Bumped independently from `@ekai/contexto`'s semver.
__compatible_contexto_api__ = "2026-05"

logger = logging.getLogger("plugins.context_engine.contexto")


def register(ctx: Any) -> None:
    """Plugin registration. Called by hermes-agent's context-engine loader."""
    engine = ContextoEngine.from_env()
    if engine is None:
        logger.error(
            "Contexto plugin not registered: CONTEXTO_API_KEY is not set. "
            "Hermes will fall back to the default 'compressor' engine. "
            "Get a key at https://getcontexto.com and `export CONTEXTO_API_KEY=...`."
        )
        return
    ctx.register_context_engine(engine)
