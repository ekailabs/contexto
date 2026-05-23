# contexto-hermes

[Contexto](https://getcontexto.com) as a context engine plugin for [hermes-agent](https://hermes-agent.nousresearch.com).

Mirrors the remote mode of `@ekai/contexto` (OpenClaw plugin) — ingestion of compacted episodes and mindmap retrieval against `api.getcontexto.com`.

## Install

```bash
pip install contexto-hermes
python -m contexto_hermes.install          # symlink into hermes-agent's plugin tree
export CONTEXTO_API_KEY=ckai_xxx
```

Then in `~/.hermes/config.yaml`:

```yaml
context:
  engine: contexto
```

## Configuration

All config is via env vars. Only `CONTEXTO_API_KEY` is required.

| Env var | Default | Meaning |
|---|---|---|
| `CONTEXTO_API_KEY` | — | API key from getcontexto.com (required) |
| `CONTEXTO_ENABLED` | `true` | When `false`, ingestion still happens but retrieval injection is disabled |
| `CONTEXTO_MAX_CONTEXT_CHARS` | `2000` | Cap on retrieved-context-block size in chars |
| `CONTEXTO_MIN_SCORE` | `0.45` | Minimum similarity score for retrieved items |
| `CONTEXTO_MAX_RESULTS` | `7` | Max items per search call |
| `CONTEXTO_SEARCH_TIMEOUT` | `10` | HTTP timeout (seconds) for search calls |
| `CONTEXTO_INGEST_TIMEOUT` | `30` | HTTP timeout (seconds) for ingest calls |

## Status

Health is observable via the engine's `get_status()`:

```python
{"auth_state": "ok" | "degraded" | "auth_error", "last_api_error": str | None, ...}
```

Hermes' `/status` command surfaces only token-level fields directly; `auth_state` transitions are logged at INFO so they appear in hermes-agent logs.

## License

MIT
