# claw-contexto

OpenClaw plugin that captures all 24 plugin lifecycle hooks to structured JSONL storage. Built for context, memory, and analytics.

Includes a local JSONL store (`src/store.ts`) so the plugin installs standalone without workspace dependencies.

## Install

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
        config: { "dataDir": "~/.openclaw/ekai/data" }
      }
    }
  }
}
```

`dataDir` defaults to `~/.openclaw/ekai/data` if not set.

## Verify

```bash
openclaw plugins list       # should show claw-contexto
openclaw hooks list         # should show plugin:claw-contexto:* hooks
```

## Storage Layout

Events are organized as one JSONL file per session, grouped by agent:

```
{dataDir}/
  {agent_id}/
    {session_id}.jsonl
```

IDs are sanitized for safe file paths (`[a-zA-Z0-9_-]` + 8-char SHA-256 hash suffix). Missing IDs fall back to `_unknown-agent` / `_unknown-session`.

Each line is a JSON object with a versioned schema:

```json
{"id":"...","v":1,"eventTs":1709500000000,"ingestTs":1709500000050,"hook":"llm_output","sessionId":"abc-3f2a1b9c","agentId":"default-8e4c7d1a","event":{...},"ctx":{...}}
```

## What It Captures

All 24 OpenClaw plugin lifecycle hooks defined in `PluginHookName` (`before_model_resolve` through `gateway_stop`).

Additional fields extracted per event: `sessionId`, `agentId`, `userId`, `conversationId`.

## Design

- **Structured storage** — one JSONL file per session via local `EventWriter`
- **Safe serialization** — handles circular refs, BigInt, Error objects (never throws)
- **Never crashes OpenClaw** — all writes are fire-and-forget with `.catch(...)`
- **Serialized async writes** — deterministic order per session file with async fs writes
- **ID sanitization** — safe file paths with collision-resistant hashing
- **Schema versioned** — every event carries `v: 1` for future migration

## Development

```bash
# Type-check (no build needed — OpenClaw loads .ts via jiti)
npm run type-check --workspace=integrations/openclaw

# Local dev install (symlink)
openclaw plugins install -l ./integrations/openclaw
```

## License

MIT
