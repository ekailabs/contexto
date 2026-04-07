# @ekai/contexto

Stop long-running OpenClaw agents from forgetting what matters.

`@ekai/contexto` is the OpenClaw plugin for Contexto, an episode-based context engine that preserves full conversation turns and retrieves the right past context when sessions get long.

## Why Use It

- Prevents context rot from repeated summarization
- Keeps earlier constraints and decisions retrievable
- Separates topics with semantic clustering
- Installs in OpenClaw with one plugin and one API key

## Install

```bash
openclaw plugins install @ekai/contexto
openclaw plugins enable contexto
openclaw config set plugins.slots.contextEngine contexto
openclaw config set plugins.entries.contexto.config.apiKey YOUR_KEY
openclaw gateway restart
```

Get an API key at [getcontexto.com](https://getcontexto.com/).

## Configuration

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `apiKey` | string | Yes | — | Your Contexto API key |
| `contextEnabled` | boolean | No | `true` | Enable or disable context injection |
| `maxContextChars` | number | No | — | Max characters for injected context |
| `compactThreshold` | number (0-1) | No | `0.50` | Ingest and evict at this share of token budget |
| `compactionStrategy` | `'sliding-window' \| 'default'` | No | `'default'` | Compaction strategy |

## How It Works

1. OpenClaw buffers full conversation episodes.
2. When the prompt budget fills up, the oldest episodes are ingested instead of being reduced to lossy summaries.
3. Episodes are clustered by semantic similarity.
4. Retrieval pulls back the most relevant episodes for the current prompt.

## Learn More

- [Repository README](https://github.com/ekailabs/contexto)
- [Website](https://getcontexto.com/)
- [Blog](https://getcontexto.com/blogs)
- [Discord](https://discord.com/invite/5VsUUEfbJk)
