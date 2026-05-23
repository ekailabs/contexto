"""Shared test setup — makes hermes-agent's ContextEngine ABC importable."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def _find_hermes_agent_root() -> Path | None:
    """Locate hermes-agent so its `agent.context_engine` module is importable.

    Checks (in order):
      1. The HERMES_AGENT_ROOT env var.
      2. ../../../hermes-agent relative to this repo (sibling under research/).
    """
    env = os.environ.get("HERMES_AGENT_ROOT")
    if env:
        path = Path(env).expanduser().resolve()
        if (path / "agent" / "context_engine.py").exists():
            return path

    here = Path(__file__).resolve()
    candidate = here.parents[4] / "hermes-agent"
    if (candidate / "agent" / "context_engine.py").exists():
        return candidate

    return None


_HERMES_ROOT = _find_hermes_agent_root()
if _HERMES_ROOT is not None and str(_HERMES_ROOT) not in sys.path:
    sys.path.insert(0, str(_HERMES_ROOT))
