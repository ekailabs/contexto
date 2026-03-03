# @ekai/contexto

OpenClaw plugin that captures all 13 lifecycle events to structured JSONL storage. Built for context, memory, and analytics.

Uses [`@ekai/store`](../../store/) for event normalization, safe serialization, and per-session file organization.

## Install

```bash
openclaw plugins install @ekai/contexto
```

## Configure

In your OpenClaw config:

```json5
{
  plugins: {
    allow: ["ekai-contexto"],
    entries: {
      "ekai-contexto": {
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
openclaw plugins list       # should show ekai-contexto
openclaw hooks list          # should show plugin:ekai-contexto:contexto:* hooks
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

All 13 OpenClaw lifecycle hooks:

| Hook | Description |
|------|-------------|
| `session_start` | Session opened |
| `session_end` | Session closed |
| `message_received` | Inbound message |
| `message_sent` | Outbound message |
| `before_prompt_build` | Pre-prompt state |
| `llm_input` | LLM request |
| `llm_output` | LLM response |
| `before_tool_call` | Pre-tool invocation |
| `after_tool_call` | Tool result |
| `tool_result_persist` | Tool result persistence |
| `agent_end` | Agent completion |
| `before_compaction` | Pre-compaction state |
| `after_compaction` | Post-compaction state |

Additional fields extracted per event: `sessionId`, `agentId`, `userId`, `conversationId`.

## Design

- **Structured storage** — one JSONL file per session via `@ekai/store` EventWriter
- **Safe serialization** — handles circular refs, BigInt, Error objects (never throws)
- **Never crashes OpenClaw** — every handler wrapped in try/catch
- **Sync writes** — `appendFileSync` for `tool_result_persist` compatibility
- **ID sanitization** — safe file paths with collision-resistant hashing
- **Schema versioned** — every event carries `v: 1` for future migration

## Development

```bash
# Type-check (no build needed — OpenClaw loads .ts via jiti)
npm run type-check --workspace=@ekai/contexto

# Build the store dependency
npm run build --workspace=store

# Run store tests
npm run test --workspace=store

# Local dev install (symlink)
openclaw plugins install -l ./integrations/openclaw
```

## License

MIT
