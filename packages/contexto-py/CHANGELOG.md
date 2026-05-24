# Changelog

## 0.1.0 — 2026-05-23

Initial release. Implements the v5 design (`docs/specs/2026-05-22-contexto-hermes-plugin-design.md`).

- Remote backend only: `POST /v1/webhooks/events`, `POST /v1/mindmap/search` against `api.getcontexto.com`.
- Standard `ContextEngine` ABC implementation.
- Compaction in `compress()`: ingest drop slice → search → inject as synthetic user/assistant pair → token-invariant guard.
- `contexto_search` engine tool.
- Env-var-only config (`CONTEXTO_*`), with bounds validation: out-of-range/NaN values fall back to defaults with a `WARNING`.
- Defensive token coercion in `update_from_response` (string/garbled provider usage counts never raise).
- Installer discovers Hermes' `plugins/context_engine` even when it is a PEP-420 namespace package.
- `python -m contexto_hermes.install` installer.

Compatible with `api.getcontexto.com` schema version pinned in `__compatible_contexto_api__`.
