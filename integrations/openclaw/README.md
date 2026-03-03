# @ekai/contexto

OpenClaw plugin that captures all 13 lifecycle events to a JSONL log. Built for context, memory, and analytics.

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
        config: { "logPath": "~/.openclaw/ekai/events.jsonl" }
      }
    }
  }
}
```

`logPath` defaults to `~/.openclaw/ekai/events.jsonl` if not set.

## Verify

```bash
openclaw plugins list       # should show ekai-contexto
openclaw hooks list          # should show plugin:ekai-contexto:contexto:* hooks
```

## What It Captures

All 13 OpenClaw lifecycle hooks, written as one JSON line per event:

```json
{"ts":1709500000000,"hook":"llm_input","sessionId":"abc","agentId":"default","event":{...},"ctx":{...}}
```

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

## Design

- **Zero runtime dependencies** — Node built-ins only
- **Safe serialization** — handles circular refs, BigInt, Error objects
- **Never crashes OpenClaw** — every handler wrapped in try/catch
- **Sync writes** — `appendFileSync` for `tool_result_persist` compatibility
- **sessionId/agentId extraction** — normalized from event or context

## Development

```bash
# Type-check (no build needed — OpenClaw loads .ts via jiti)
npm run type-check --workspace=@ekai/contexto

# Local dev install (symlink)
openclaw plugins install -l ./integrations/openclaw
```

## License

MIT
