"""Sanity test for plugin.yaml — required env_vars and name."""

from __future__ import annotations

from pathlib import Path

import yaml

PLUGIN_YAML = Path(__file__).parent.parent / "src" / "contexto_hermes" / "plugin.yaml"


def _load() -> dict:
    return yaml.safe_load(PLUGIN_YAML.read_text())


def test_name_is_contexto() -> None:
    assert _load()["name"] == "contexto"


def test_required_env_vars_present() -> None:
    data = _load()
    names = {ev["name"] for ev in data["env_vars"]}
    for required in (
        "CONTEXTO_API_KEY",
        "CONTEXTO_ENABLED",
        "CONTEXTO_MAX_CONTEXT_CHARS",
        "CONTEXTO_MIN_SCORE",
        "CONTEXTO_MAX_RESULTS",
        "CONTEXTO_SEARCH_TIMEOUT",
        "CONTEXTO_INGEST_TIMEOUT",
    ):
        assert required in names, f"missing env var: {required}"


def test_api_key_marked_required() -> None:
    data = _load()
    api_key_entry = next(ev for ev in data["env_vars"] if ev["name"] == "CONTEXTO_API_KEY")
    assert api_key_entry.get("required") is True


def test_version_matches_package() -> None:
    import contexto_hermes
    assert _load()["version"] == contexto_hermes.__version__
