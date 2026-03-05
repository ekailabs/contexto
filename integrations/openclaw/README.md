# claw-contexto

OpenClaw plugin that provides local-first memory — ingest conversation turns and recall relevant context automatically.

Uses [`@ekai/memory`](../../memory/) for semantic extraction, embedding, and SQLite storage.

## Install

```bash
openclaw plugins install claw-contexto
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
    allow: ["claw-contexto"],
    entries: {
      "claw-contexto": {
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
| `provider` | (env-based) | LLM provider for extraction/embedding (`openai`, `gemini`, `openrouter`) |
| `apiKey` | (env-based) | API key for the selected provider |
| `bootstrapDelayMs` | `1000` | Milliseconds to wait between sessions during bootstrap backfill |

## Verify

```bash
openclaw plugins list       # should show claw-contexto
openclaw hooks list         # should show plugin:claw-contexto:* hooks
```

## Bootstrap

If the plugin is installed on an existing OpenClaw instance with historical conversations, use the `/memory-bootstrap` slash command to backfill all session transcripts into memory:

```
/memory-bootstrap
```

Bootstrap scans `{stateDir}/agents/*/sessions/*.jsonl`, parses each session, and ingests the messages. Progress is tracked per-session so it can resume if interrupted. Running the command again after completion returns immediately. Configure `bootstrapDelayMs` to control pacing.

## How It Works

Two hooks and a slash command:

1. **`agent_end`** — Ingests new conversation turns into memory (ongoing). Normalizes messages (user + assistant only), redacts secrets, extracts semantic memories via `@ekai/memory`. Only processes the delta since the last ingestion.

2. **`before_prompt_build`** — Recalls relevant memories for the current query and prepends them as context (capped at 2000 chars).

3. **`/memory-bootstrap`** — One-time backfill of all existing session transcripts. Scans the OpenClaw state directory for historical JSONL session files and ingests them into memory. Runs in the background with configurable delay between sessions. Idempotent — safe to re-run.

Delta tracking is persisted to `{dbPath}.progress.json` using composite keys (`agentId:sessionId`) so only new messages are ingested, even across restarts. Both ongoing ingestion and bootstrap share the same progress file.

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
