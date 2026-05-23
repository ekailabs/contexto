"""Tests for the plugin entry point (`register(ctx)`)."""

from __future__ import annotations

import logging

import pytest


class _CapturingCtx:
    """Mimics hermes-agent's `_EngineCollector`."""

    def __init__(self) -> None:
        self.registered: list = []
        self.tools: list = []
        self.hooks: list = []

    def register_context_engine(self, engine) -> None:
        self.registered.append(engine)

    def register_tool(self, *a, **kw) -> None:  # no-op shim
        self.tools.append((a, kw))

    def register_hook(self, *a, **kw) -> None:
        self.hooks.append((a, kw))

    def register_cli_command(self, *a, **kw) -> None: ...
    def register_memory_provider(self, *a, **kw) -> None: ...


def test_register_with_api_key_registers_engine(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTEXTO_API_KEY", "ckai_abc")
    import contexto_hermes
    ctx = _CapturingCtx()
    contexto_hermes.register(ctx)
    assert len(ctx.registered) == 1
    assert ctx.registered[0].name == "contexto"


def test_register_without_api_key_does_not_register(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.delenv("CONTEXTO_API_KEY", raising=False)
    import contexto_hermes
    ctx = _CapturingCtx()
    with caplog.at_level(logging.ERROR, logger="plugins.context_engine.contexto"):
        contexto_hermes.register(ctx)
    assert ctx.registered == []
    assert any("CONTEXTO_API_KEY" in r.message for r in caplog.records)


def test_compatible_api_version_constant_is_a_string() -> None:
    import contexto_hermes
    assert isinstance(contexto_hermes.__compatible_contexto_api__, str)
    assert len(contexto_hermes.__compatible_contexto_api__) > 0


def test_engine_class_exported() -> None:
    import contexto_hermes
    assert hasattr(contexto_hermes, "ContextoEngine")
