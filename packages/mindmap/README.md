# @ekai/mindmap

OpenClaw plugin — Context graph engine that prevents context rot by visualizing and organizing conversation context.

## Purpose

Mind Map is an improved **context engine** for OpenClaw that solves **context rot** — the gradual degradation of agent responses as conversation history grows. It builds a contextual representation of your conversations that allows the agent to maintain relevance and coherence over extended sessions.

- Uses **semantic clustering** to group related messages and concepts
- Maps relationships between messages, concepts, and session states
- Provides structured context retrieval to combat context rot
- Enables the agent to understand conversation topology

## Installation

```bash
npm install @ekai/mindmap
```

## OpenClaw Setup

### 1. Install the plugin in OpenClaw

```bash
openclaw plugins install @ekai/mindmap
```

### 2. Enable and configure the plugin

Add to your OpenClaw config:

```json
{
  "plugins": {
    "slots": {
      "mindMap": "@ekai/mindmap"
    },
    "allow": ["@ekai/mindmap"],
    "entries": {
      "@ekai/mindmap": {
        "enabled": true,
        "config": {
          "apiKey": "your-api-key-here"
        }
      }
    }
  }
}
```

### 3. Restart OpenClaw

```bash
openclaw gateway restart
```

## Configuration

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `apiKey` | string | Yes | Your Contexto API key |

## License

MIT
