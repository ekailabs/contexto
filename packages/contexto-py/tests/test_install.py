"""Tests for `python -m contexto_hermes.install`."""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

import pytest

from contexto_hermes import install


@pytest.fixture
def fake_hermes(tmp_path: Path) -> Path:
    """A throwaway hermes-agent-like tree with plugins/context_engine/."""
    root = tmp_path / "fake_hermes"
    (root / "plugins" / "context_engine").mkdir(parents=True)
    # The marker file the loader looks for:
    (root / "plugins" / "context_engine" / "__init__.py").write_text("# stub\n")
    return root


@pytest.fixture
def fake_package_dir(tmp_path: Path) -> Path:
    """A directory pretending to be the installed contexto_hermes package."""
    src = tmp_path / "site-packages" / "contexto_hermes"
    src.mkdir(parents=True)
    (src / "__init__.py").write_text("# stub\n")
    (src / "plugin.yaml").write_text("name: contexto\n")
    return src


class TestDetectHermesContextEngineDir:
    def test_via_env_var(self, fake_hermes: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(fake_hermes))
        path = install.detect_hermes_context_engine_dir()
        assert path == fake_hermes / "plugins" / "context_engine"

    def test_returns_none_when_invalid(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(tmp_path / "nope"))
        # Also kill sys.path discovery for this test
        monkeypatch.setattr(install, "_discover_via_sys_path", lambda: None)
        assert install.detect_hermes_context_engine_dir() is None

    def test_via_env_var_namespace_package_no_init(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # PEP-420 namespace layout: plugins/context_engine/ exists with NO __init__.py.
        root = tmp_path / "ns_hermes"
        (root / "plugins" / "context_engine").mkdir(parents=True)
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(root))
        path = install.detect_hermes_context_engine_dir()
        assert path == root / "plugins" / "context_engine"

    def test_discover_via_sys_path_uses_namespace_search_locations(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Simulate find_spec returning a namespace-package spec: origin is None,
        # directory only reachable via submodule_search_locations.
        ns_dir = tmp_path / "site" / "plugins" / "context_engine"
        ns_dir.mkdir(parents=True)

        class _NamespaceSpec:
            origin = None
            submodule_search_locations = [str(ns_dir)]

        monkeypatch.setattr(
            install.importlib.util, "find_spec", lambda name: _NamespaceSpec()
        )
        assert install._discover_via_sys_path() == ns_dir


class TestInstallPlugin:
    def test_creates_symlink_to_package(
        self, fake_hermes: Path, fake_package_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(fake_hermes))
        result = install.install_plugin(package_dir=fake_package_dir)
        assert result.success is True
        target = fake_hermes / "plugins" / "context_engine" / "contexto"
        assert target.exists()
        # Either symlink or copy
        if target.is_symlink():
            assert target.resolve() == fake_package_dir.resolve()
        else:
            assert (target / "plugin.yaml").exists()

    def test_idempotent_second_run(
        self, fake_hermes: Path, fake_package_dir: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(fake_hermes))
        install.install_plugin(package_dir=fake_package_dir)
        # Run again — should not error
        result = install.install_plugin(package_dir=fake_package_dir)
        assert result.success is True
        target = fake_hermes / "plugins" / "context_engine" / "contexto"
        assert target.exists()

    def test_copy_fallback_when_symlink_fails(
        self,
        fake_hermes: Path,
        fake_package_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(fake_hermes))

        def boom(src, dst, *args, **kwargs):  # noqa: ARG001
            raise OSError("symlink not supported")

        monkeypatch.setattr(install.os, "symlink", boom)
        result = install.install_plugin(package_dir=fake_package_dir)
        assert result.success is True
        target = fake_hermes / "plugins" / "context_engine" / "contexto"
        assert target.exists()
        assert not target.is_symlink()
        assert (target / "plugin.yaml").exists()

    def test_returns_failure_when_target_dir_unwritable(
        self,
        tmp_path: Path,
        fake_package_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        readonly_root = tmp_path / "ro_hermes"
        (readonly_root / "plugins" / "context_engine").mkdir(parents=True)
        (readonly_root / "plugins" / "context_engine" / "__init__.py").write_text("")
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(readonly_root))
        os.chmod(readonly_root / "plugins" / "context_engine", 0o555)
        try:
            result = install.install_plugin(package_dir=fake_package_dir)
            assert result.success is False
            assert "write" in result.message.lower() or "permission" in result.message.lower()
        finally:
            os.chmod(readonly_root / "plugins" / "context_engine", 0o755)

    def test_returns_failure_when_no_hermes_detected(
        self, fake_package_dir: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(tmp_path / "nope"))
        monkeypatch.setattr(install, "_discover_via_sys_path", lambda: None)
        result = install.install_plugin(package_dir=fake_package_dir)
        assert result.success is False
        assert "hermes" in result.message.lower()


class TestMainEntryPoint:
    def test_main_returns_zero_on_success(
        self,
        fake_hermes: Path,
        fake_package_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(fake_hermes))
        monkeypatch.setattr(install, "_resolve_package_dir", lambda: fake_package_dir)
        rc = install.main([])
        assert rc == 0

    def test_main_returns_nonzero_on_failure(
        self,
        fake_package_dir: Path,
        monkeypatch: pytest.MonkeyPatch,
        tmp_path: Path,
    ) -> None:
        monkeypatch.setenv("HERMES_AGENT_ROOT", str(tmp_path / "no-such-dir"))
        monkeypatch.setattr(install, "_discover_via_sys_path", lambda: None)
        monkeypatch.setattr(install, "_resolve_package_dir", lambda: fake_package_dir)
        rc = install.main([])
        assert rc != 0
