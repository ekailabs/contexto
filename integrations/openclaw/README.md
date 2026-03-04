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

## Verify

```bash
openclaw plugins list       # should show claw-contexto
openclaw hooks list         # should show plugin:claw-contexto:* hooks
```

## How It Works

Two hooks:

1. **`agent_end`** — Ingests new conversation turns into memory. Normalizes messages (user + assistant only), redacts secrets, extracts semantic memories via `@ekai/memory`.

2. **`before_prompt_build`** — Recalls relevant memories for the current query and prepends them as context (capped at 2000 chars).

Delta tracking is persisted to `{dbPath}.progress.json` so only new messages are ingested, even across restarts.

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
