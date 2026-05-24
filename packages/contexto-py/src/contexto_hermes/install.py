"""`python -m contexto_hermes.install` — drop the plugin into hermes-agent's tree.

Hermes' context-engine loader only scans `plugins/context_engine/<name>/` inside
the installed hermes-agent; `$HERMES_HOME/plugins/` is NOT scanned. The plugin
must land in the bundled tree.

Detection order:
  1. `HERMES_AGENT_ROOT` env var (explicit override).
  2. Discovery via `import plugins.context_engine` — uses the same import
     resolution Hermes itself uses.
"""

from __future__ import annotations

import argparse
import importlib.util
import logging
import os
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

logger = logging.getLogger("plugins.context_engine.contexto")

_PLUGIN_NAME = "contexto"


@dataclass
class InstallResult:
    success: bool
    message: str
    target: Path | None = None


def _discover_via_sys_path() -> Path | None:
    """Find plugins/context_engine/ via the same import path Hermes uses.

    Handles both regular packages (``spec.origin`` points at ``__init__.py``)
    and PEP-420 namespace packages (``spec.origin`` is None — the directory is
    only reachable via ``submodule_search_locations``), which Hermes plugin
    host trees commonly use.
    """
    spec = importlib.util.find_spec("plugins.context_engine")
    if spec is None:
        return None
    if spec.origin is not None:
        return Path(spec.origin).parent
    for location in spec.submodule_search_locations or []:
        return Path(location)
    return None


def detect_hermes_context_engine_dir() -> Path | None:
    env = os.environ.get("HERMES_AGENT_ROOT")
    if env:
        candidate = Path(env).expanduser().resolve() / "plugins" / "context_engine"
        if candidate.is_dir():
            return candidate

    discovered = _discover_via_sys_path()
    if discovered is not None and discovered.is_dir():
        return discovered

    return None


def _resolve_package_dir() -> Path:
    """Find the installed contexto_hermes package directory on disk."""
    spec = importlib.util.find_spec("contexto_hermes")
    if spec is None or spec.origin is None:
        raise RuntimeError("contexto_hermes is not importable")
    return Path(spec.origin).parent


def _check_writable(directory: Path) -> bool:
    return os.access(directory, os.W_OK)


def install_plugin(package_dir: Path | None = None) -> InstallResult:
    """Symlink (or copy) the plugin into hermes-agent's plugins/context_engine/."""
    target_parent = detect_hermes_context_engine_dir()
    if target_parent is None:
        return InstallResult(
            success=False,
            message=(
                "Could not locate hermes-agent's plugins/context_engine directory. "
                "Set HERMES_AGENT_ROOT or install hermes-agent so that "
                "`python -c 'import plugins.context_engine'` resolves."
            ),
        )

    if not _check_writable(target_parent):
        return InstallResult(
            success=False,
            message=(
                f"No write permission on {target_parent}. "
                "Re-run with sudo, or install Hermes into a writable location."
            ),
            target=target_parent,
        )

    src = (package_dir or _resolve_package_dir()).resolve()
    target = target_parent / _PLUGIN_NAME

    # Remove any prior install (symlink, dir, or stray file).
    if target.is_symlink() or target.is_file():
        target.unlink()
    elif target.is_dir():
        shutil.rmtree(target)

    try:
        os.symlink(src, target, target_is_directory=True)
        logger.info("[contexto] installed symlink: %s → %s", target, src)
        return InstallResult(success=True, message=f"Symlinked {target} → {src}", target=target)
    except OSError as exc:
        logger.info("[contexto] symlink failed (%s); falling back to copy", exc)

    try:
        shutil.copytree(src, target)
        logger.info("[contexto] installed copy: %s", target)
        return InstallResult(success=True, message=f"Copied to {target}", target=target)
    except Exception as exc:  # noqa: BLE001
        return InstallResult(
            success=False,
            message=f"Failed to install plugin: {exc}",
            target=target,
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m contexto_hermes.install",
        description="Install the Contexto plugin into hermes-agent's context-engine slot.",
    )
    parser.add_argument(
        "--package-dir",
        type=Path,
        default=None,
        help="Override the source package directory (default: installed contexto_hermes).",
    )
    args = parser.parse_args(argv)

    package_dir = args.package_dir or _resolve_package_dir()
    result = install_plugin(package_dir=package_dir)

    if result.success:
        sys.stderr.write(f"[contexto-hermes] {result.message}\n")
        return 0
    sys.stderr.write(f"[contexto-hermes] ERROR: {result.message}\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
