# contexto-hermes

[Contexto](https://getcontexto.com) as a context engine plugin for [hermes-agent](https://hermes-agent.nousresearch.com).

Two interchangeable backends:

- **Remote (default)** — ingestion + mindmap retrieval against `api.getcontexto.com`.
- **Local** — pure-Python pipeline; embeddings + summarization call the user's own OpenAI/OpenRouter key; state lives on disk as a single JSON file.

## Install

```bash
pip install contexto-hermes
contexto-hermes-install                    # symlink into hermes-agent's plugin tree
```

Then in `~/.hermes/config.yaml`:

```yaml
context:
  engine: contexto
```

Pick a backend and set its key:

```bash
# Remote (default)
export CONTEXTO_API_KEY=ckai_xxx

# Local — pick a provider; either key works.
export CONTEXTO_BACKEND=local
export OPENROUTER_API_KEY=sk-or-xxx   # or OPENAI_API_KEY=sk-xxx
```

For a copy-paste walkthrough with verification + Docker notes, see [`docs/contexto-hermes-quickstart.md`](../../docs/contexto-hermes-quickstart.md).

## Configuration

All config is via env vars. Invalid, out-of-range, or NaN values fall back to the default with a `WARNING`; they never block registration.

### Shared

| Env var | Default | Meaning |
|---|---|---|
| `CONTEXTO_BACKEND` | `remote` | `remote` or `local` |
| `CONTEXTO_ENABLED` | `true` | When `false`, ingestion still happens but retrieval injection is disabled |
| `CONTEXTO_MAX_CONTEXT_CHARS` | `2000` | Cap on retrieved-context-block size in chars (must be ≥ 1) |
| `CONTEXTO_MIN_SCORE` | `0.45` remote / `0.35` local | Minimum similarity score for retrieved items (0.0–1.0). Local summaries span a whole drop slice, so relevant hits score lower. |
| `CONTEXTO_MAX_RESULTS` | `7` | Items fetched per automatic recall at compaction time |
| `CONTEXTO_SEARCH_TIMEOUT` | `10` | HTTP timeout (seconds) for search calls |
| `CONTEXTO_INGEST_TIMEOUT` | `30` | HTTP timeout (seconds) for ingest calls |

### Remote backend (`CONTEXTO_BACKEND=remote`)

| Env var | Default | Meaning |
|---|---|---|
| `CONTEXTO_API_KEY` | — | API key from getcontexto.com (required for remote) |

### Local backend (`CONTEXTO_BACKEND=local`)

Requires one of `OPENAI_API_KEY` or `OPENROUTER_API_KEY`. Adds `numpy` + `scipy` as runtime deps.

| Env var | Default | Meaning |
|---|---|---|
| `CONTEXTO_LOCAL_PROVIDER` | inferred (openrouter wins if both keys set; else openai) | `openai` or `openrouter` |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | — | Provider key matching `CONTEXTO_LOCAL_PROVIDER` |
| `CONTEXTO_LOCAL_STORAGE_PATH` | `$HERMES_HOME/data/contexto/mindmap.json` (≈ `~/.hermes/data/contexto/mindmap.json` locally, `/opt/data/data/contexto/mindmap.json` in the Hermes Docker image) | On-disk mindmap JSON path |
| `CONTEXTO_LOCAL_EMBED_MODEL` | provider default (`text-embedding-3-small` / `openai/text-embedding-3-small`) | Override the embeddings model |
| `CONTEXTO_LOCAL_LLM_MODEL` | provider default (`gpt-4o-mini` / `openai/gpt-4o-mini`) | Override the summarization model |
| `CONTEXTO_LOCAL_SUMMARIZE` | `true` | When `false`, skips per-ingest LLM summarization and uses a synthetic summary |
| `CONTEXTO_LOCAL_SIMILARITY_THRESHOLD` | `0.65` | Cosine threshold for cluster cuts + beam pruning |
| `CONTEXTO_LOCAL_MAX_DEPTH` | `4` | Maximum tree depth |
| `CONTEXTO_LOCAL_MAX_CHILDREN` | `10` | Informational (matches TS; not enforced as a hard cap) |
| `CONTEXTO_LOCAL_REBUILD_INTERVAL` | `50` | Items between full rebuilds |
| `CONTEXTO_LOCAL_BEAM_WIDTH` | `3` | Retrieval beam width |
| `CONTEXTO_LOCAL_EMBED_TIMEOUT` | `30` | Embeddings request timeout (seconds) |
| `CONTEXTO_LOCAL_LLM_TIMEOUT` | `60` | LLM request timeout (seconds) |

`CONTEXTO_API_KEY` is ignored in local mode. Explicit `CONTEXTO_LOCAL_PROVIDER` never silently falls back to the other provider — failing loudly beats quietly billing the wrong account.

`CONTEXTO_MAX_RESULTS` sets recall breadth at compaction time. The `contexto_search` tool takes its own `max_results` (default `5`) for on-demand recall.

## Status

Health is observable via the engine's `get_status()`:

```python
{
    "auth_state": "ok" | "degraded" | "auth_error",
    "last_api_error": str | None,
    "consecutive_ingest_failures": int,   # fail-closed compactions in a row
    "last_ingest_failure": str | None,    # reason for the last fail-closed ingest
    ...
}
```

On ingest failure, `compress()` fails closed — original messages kept, retrieval skipped, compaction count unchanged — so unpersisted history is never dropped. The counters above surface a sustained outage (e.g. a rate-limit window). The `auth_state` / `last_api_error` fields are remote-specific; the local backend leaves `auth_state="ok"` and surfaces failures through the consecutive-ingest counters and standard logging.

Hermes' `/status` command surfaces only token-level fields directly; `auth_state` transitions are logged at INFO so they appear in hermes-agent logs.

## License

MIT
