# @ekai/contexto

OpenClaw plugin — Context graph engine that prevents context rot by visualizing and organizing conversation context.

## Purpose

Mind Map is an improved **context engine** for OpenClaw that solves **context rot** — the gradual degradation of agent responses as conversation history grows. It builds a contextual representation of your conversations that allows the agent to maintain relevance and coherence over extended sessions.

- Uses **semantic clustering** to group related messages and concepts
- Maps relationships between messages, concepts, and session states
- Provides structured context retrieval to combat context rot
- Enables the agent to understand conversation topology

## OpenClaw Setup

### 1. Install the plugin in OpenClaw

```bash
openclaw plugins install @ekai/contexto
openclaw plugins enable contexto
```

### 2. Set Contexto as the context engine

```bash
openclaw config set plugins.slots.contextEngine contexto
```

### 3. Configure your API key

Set your API key via CLI:

```bash
openclaw config set plugins.entries.contexto.config.apiKey your-api-key-here
```

Or add to your OpenClaw config:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "contexto"
    },
    "allow": ["contexto"],
    "entries": {
      "contexto": {
        "enabled": true,
        "config": {
          "apiKey": "your-api-key-here"
        }
      }
    }
  }
}
```

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

## Configuration

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `apiKey` | string | Yes | Your Contexto API key |

## Version

This is **v1** of @ekai/contexto. For the legacy version (v0), see [`../v0`](../v0).

## License

MIT