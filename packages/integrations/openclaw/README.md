# @ekai/contexto

OpenClaw plugin that provides local-first memory — ingest conversation turns and recall relevant context automatically.

Uses [`@ekai/memory`](../../memory/) for semantic extraction, embedding, and SQLite storage.

## Install

```bash
openclaw plugins install @ekai/contexto
```

Or from source:
```bash
openclaw plugins install ./integrations/openclaw
```

## Configure

In your OpenClaw config:

```json5
{
  plugins: {
    slots: {
      contextEngine: "@ekai/contexto"
    },
    allow: ["@ekai/contexto"],
    entries: {
      "@ekai/contexto": {
        enabled: true,
        config: {
          "dbPath": "~/.openclaw/ekai/memory.db",
          "provider": "openai",
          "apiKey": "sk-..."
        }
      }
    }
  }
}
```

| Setting | Default | Description |
|---------|---------|-------------|
| `dbPath` | `~/.openclaw/ekai/memory.db` | Path to SQLite memory file |
| `provider` | (auto-detected) | LLM provider for extraction/embedding (`openai`, `gemini`, `openrouter`) |
| `apiKey` | (auto-detected) | API key for the selected provider |
| `bootstrapDelayMs` | `1000` | Milliseconds to wait between sessions during bootstrap backfill |

### Provider auto-detection

When `provider` and `apiKey` are not explicitly configured, the plugin auto-detects from environment variables:

1. **Both `provider` + `apiKey` in config** — used as-is
2. **Only `provider` in config** — API key resolved from the provider's env var (e.g. `OPENAI_API_KEY`)
3. **Only `apiKey` in config** — ignored with a warning (ambiguous without provider)
4. **`MEMORY_EMBED_PROVIDER` or `MEMORY_EXTRACT_PROVIDER` set** — defers to `@ekai/memory` core
5. **Auto-detect from env** — checks `OPENAI_API_KEY` → `GOOGLE_API_KEY` → `OPENROUTER_API_KEY` (first match wins)
6. **Nothing found** — passes no provider, lets core handle the error

## Verify

```bash
openclaw plugins list       # should show @ekai/contexto
openclaw config get plugins.slots.contextEngine  # should show @ekai/contexto
```

## Bootstrap

If the plugin is installed on an existing OpenClaw instance with historical conversations, use the `/memory-bootstrap` slash command to backfill all session transcripts into memory:

```
/memory-bootstrap
```

Bootstrap scans `{stateDir}/agents/*/sessions/*.jsonl`, parses each session, and ingests the messages. Progress is tracked per-session so it can resume if interrupted. Running the command again after completion returns immediately. Configure `bootstrapDelayMs` to control pacing.

## How It Works

ContextEngine lifecycle methods and a slash command:

1. **`assemble()`** — Recalls relevant memories for the current query and injects them via `systemPromptAddition` (capped at 2000 chars).

2. **`afterTurn()`** — Ingests new conversation turns into memory. Normalizes messages (user + assistant only), redacts secrets, extracts semantic memories via `@ekai/memory`. Only processes the delta since the last ingestion.

3. **`/memory-bootstrap`** — One-time backfill of all existing session transcripts. Scans the OpenClaw state directory for historical JSONL session files and ingests them into memory. Runs in the background with configurable delay between sessions. Idempotent — safe to re-run.

Delta tracking is persisted to `{dbPath}.progress.json` using composite keys (`agentId:sessionId`) so only new messages are ingested, even across restarts. Both ongoing ingestion and bootstrap share the same progress file.

> **Upgrade from 0.1.x:** This version requires OpenClaw v2026.3.7+ and the `plugins.slots.contextEngine` setting. The old hook-based approach (`agent_end` / `before_prompt_build`) is no longer used.

## Development

```bash
# Type-check (no build needed -- OpenClaw loads .ts via jiti)
npm run type-check --workspace=integrations/openclaw

# Run tests
npm test --workspace=integrations/openclaw

# Local dev install (symlink)
openclaw plugins install -l ./integrations/openclaw
```

## License

MIT
