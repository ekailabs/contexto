"""Tests for contexto_hermes.types — config + dataclasses."""

from __future__ import annotations

import logging

import pytest

from contexto_hermes.types import (
    ApiError,
    ContextoConfig,
    SearchResult,
    WebhookPayload,
    _env_bool,
    _env_float,
    _env_int,
)


class TestContextoConfigFromEnv:
    def test_returns_none_when_api_key_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CONTEXTO_API_KEY", raising=False)
        assert ContextoConfig.from_env() is None

    def test_returns_none_when_api_key_empty_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CONTEXTO_API_KEY", "")
        assert ContextoConfig.from_env() is None

    def test_uses_defaults_when_only_key_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CONTEXTO_API_KEY", "ckai_abc")
        for var in [
            "CONTEXTO_ENABLED",
            "CONTEXTO_MAX_CONTEXT_CHARS",
            "CONTEXTO_MIN_SCORE",
            "CONTEXTO_MAX_RESULTS",
            "CONTEXTO_SEARCH_TIMEOUT",
            "CONTEXTO_INGEST_TIMEOUT",
        ]:
            monkeypatch.delenv(var, raising=False)
        cfg = ContextoConfig.from_env()
        assert cfg is not None
        assert cfg.api_key == "ckai_abc"
        assert cfg.context_enabled is True
        assert cfg.max_context_chars == 2000
        assert cfg.min_score == 0.45
        assert cfg.max_results == 7
        assert cfg.search_timeout == 10.0
        assert cfg.ingest_timeout == 30.0

    def test_reads_all_env_overrides(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CONTEXTO_API_KEY", "ckai_xyz")
        monkeypatch.setenv("CONTEXTO_ENABLED", "false")
        monkeypatch.setenv("CONTEXTO_MAX_CONTEXT_CHARS", "500")
        monkeypatch.setenv("CONTEXTO_MIN_SCORE", "0.7")
        monkeypatch.setenv("CONTEXTO_MAX_RESULTS", "3")
        monkeypatch.setenv("CONTEXTO_SEARCH_TIMEOUT", "5")
        monkeypatch.setenv("CONTEXTO_INGEST_TIMEOUT", "15")
        cfg = ContextoConfig.from_env()
        assert cfg is not None
        assert cfg.context_enabled is False
        assert cfg.max_context_chars == 500
        assert cfg.min_score == 0.7
        assert cfg.max_results == 3
        assert cfg.search_timeout == 5.0
        assert cfg.ingest_timeout == 15.0


class TestEnvBool:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("true", True), ("True", True), ("TRUE", True),
            ("1", True), ("yes", True), ("YES", True), ("on", True),
            ("false", False), ("False", False), ("FALSE", False),
            ("0", False), ("no", False), ("NO", False), ("off", False),
        ],
    )
    def test_parses_truthy_and_falsy(self, monkeypatch: pytest.MonkeyPatch, raw: str, expected: bool) -> None:
        monkeypatch.setenv("CONTEXTO_TEST_BOOL", raw)
        assert _env_bool("CONTEXTO_TEST_BOOL", default=not expected) is expected

    def test_missing_returns_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CONTEXTO_TEST_BOOL", raising=False)
        assert _env_bool("CONTEXTO_TEST_BOOL", default=True) is True
        assert _env_bool("CONTEXTO_TEST_BOOL", default=False) is False

    def test_invalid_returns_default_with_warning(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setenv("CONTEXTO_TEST_BOOL", "maybe")
        with caplog.at_level(logging.WARNING, logger="plugins.context_engine.contexto"):
            assert _env_bool("CONTEXTO_TEST_BOOL", default=True) is True
        assert any("CONTEXTO_TEST_BOOL" in r.message for r in caplog.records)


class TestEnvInt:
    def test_parses_int(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CONTEXTO_TEST_INT", "42")
        assert _env_int("CONTEXTO_TEST_INT", default=0) == 42

    def test_missing_returns_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CONTEXTO_TEST_INT", raising=False)
        assert _env_int("CONTEXTO_TEST_INT", default=9) == 9

    def test_invalid_returns_default_with_warning(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setenv("CONTEXTO_TEST_INT", "not-a-number")
        with caplog.at_level(logging.WARNING, logger="plugins.context_engine.contexto"):
            assert _env_int("CONTEXTO_TEST_INT", default=11) == 11
        assert any("CONTEXTO_TEST_INT" in r.message for r in caplog.records)


class TestEnvFloat:
    def test_parses_float(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CONTEXTO_TEST_FLOAT", "0.25")
        assert _env_float("CONTEXTO_TEST_FLOAT", default=0.0) == 0.25

    def test_int_string_parses_as_float(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("CONTEXTO_TEST_FLOAT", "10")
        assert _env_float("CONTEXTO_TEST_FLOAT", default=0.0) == 10.0

    def test_missing_returns_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv("CONTEXTO_TEST_FLOAT", raising=False)
        assert _env_float("CONTEXTO_TEST_FLOAT", default=1.5) == 1.5

    def test_invalid_returns_default_with_warning(
        self, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
    ) -> None:
        monkeypatch.setenv("CONTEXTO_TEST_FLOAT", "nope")
        with caplog.at_level(logging.WARNING, logger="plugins.context_engine.contexto"):
            assert _env_float("CONTEXTO_TEST_FLOAT", default=2.5) == 2.5
        assert any("CONTEXTO_TEST_FLOAT" in r.message for r in caplog.records)


class TestDataclasses:
    def test_api_error_defaults(self) -> None:
        err = ApiError(category="auth", message="bad key")
        assert err.category == "auth"
        assert err.message == "bad key"
        assert err.retry_after is None

    def test_api_error_with_retry_after(self) -> None:
        err = ApiError(category="ratelimit", message="too many", retry_after=12.0)
        assert err.retry_after == 12.0

    def test_search_result_minimal(self) -> None:
        sr = SearchResult(items=[], paths=[])
        assert sr.items == []
        assert sr.paths == []

    def test_webhook_payload_is_typealias_for_dict(self) -> None:
        # WebhookPayload is a TypeAlias for dict[str, Any]; verify import succeeds
        # and that a dict can be passed where WebhookPayload is expected.
        payload: WebhookPayload = {"event": {"type": "episode", "action": "combined"}}
        assert payload["event"]["type"] == "episode"
