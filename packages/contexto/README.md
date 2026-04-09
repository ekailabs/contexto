# Contexto

**Keep long-running OpenClaw agents reliable after the context window fills.**

A drop-in OpenClaw context engine that retrieves old constraints instead of losing them to summaries.

[Quick Start](#quick-start) · [Why Contexto](#why-contexto) · [How It Works](#how-it-works) · [Website](https://getcontexto.com/) · [Discord](https://discord.gg/4QTRS5ew)

OpenClaw works well until long sessions start compacting away the exact instruction that mattered.
Contexto is the context engine built for that failure mode.

## The Problem in 15 Seconds

```text
Turn 2:
"Flag suspicious emails.
Do NOT delete anything."

[... 30 more turns:
tools, retries, compaction ...]
```

**Without Contexto**

```text
Turn 35: Agent deletes 12 flagged emails.
The constraint was lost in compaction.
```

**With Contexto**

```text
Turn 35: Agent flags 4 new suspicious emails.

Retrieved context:
  -> user constraint: flag only, never delete

The instruction survives compaction.
```

## Why Contexto

Contexto is a context engine for OpenClaw. It is built for the exact moment OpenClaw starts dropping or blurring the context your agent still needs:

- early instructions get compacted away
- summaries turn into summaries of summaries
- unrelated topics blur together
- the agent becomes less reliable the longer you use it

Contexto fixes that by storing full episodes and retrieving only the context that is relevant right now.

## What You Get

- Keeps important constraints retrievable even after long sessions and compaction
- Stores full episodes instead of collapsing everything into lossy summaries
- Separates topics with semantic clustering so retrieval stays clean
- Surfaces explainable paths such as `travel -> Japan -> visa docs`
- Drops into OpenClaw as one plugin with one config key

## Quick Start

Built for OpenClaw today. Managed hosting is available, so you do not need to run retrieval infrastructure yourself.

```bash
openclaw plugins install @ekai/contexto
openclaw plugins enable contexto
openclaw config set plugins.slots.contextEngine contexto
openclaw config set plugins.entries.contexto.config.apiKey YOUR_KEY
openclaw gateway restart
```

Get an API key at [getcontexto.com](https://getcontexto.com/).

If your agent ever forgets a rule, preference, or prior decision after a long run, this is the switch to try first.

## Who Should Use This

- OpenClaw users whose sessions run long enough to compact
- Agents where forgotten constraints are costly
- Teams that want better reliability without prompt hacks
- Not for one-shot chats or very short sessions

## How Contexto Compares

If you are deciding whether this is worth installing, this is the short version.

| | Default OpenClaw | **Contexto** |
|---|---|---|
| **When the context window fills** | Older turns get compacted into a summary entry; recent messages stay intact | Full episodes get ingested and indexed |
| **Keeps earlier instructions?** | Degrades over time | Yes, original episodes remain retrievable |
| **Keeps topics separated?** | No, unrelated topics get blurred together | Yes, semantic clustering keeps branches distinct |
| **Can you explain what was retrieved?** | No | Yes, full path tracing (`travel -> Japan -> visa docs`) |
| **Setup time** | Built-in | One plugin install, one config key |

## How It Works

Contexto turns aging conversation history into a searchable context tree instead of a lossy summary blob.

1. OpenClaw buffers conversation turns as full episodes.
2. When the prompt budget crosses the compaction threshold, the oldest episodes are ingested.
3. Episodes are clustered with hierarchical similarity, so related work lands in the same branch.
4. Retrieval uses beam search to pull back the most relevant episodes for the current prompt.

That means old context is not gone. It is organized.

### Under the Hood

- **Episodes and sliding window**: the storage unit is a full turn, including tool output.
- **Hierarchical clustering (AGNES)**: related episodes are grouped without predefined categories.
- **Multi-branch beam search**: retrieval can pull from several relevant branches in one pass.
- **Hybrid rebuild strategy**: periodic full rebuilds plus cheaper incremental inserts between them.

For the deeper technical reasoning:

- [Fixing Context Collapse in Long-Running Agents](https://getcontexto.com/blogs/contexto-mindmap)
- [Your AI Agent Isn't Broken. It's Missing the Context Engine](https://getcontexto.com/blogs/context-engine)
- [Why We Chose Hierarchical Clustering](https://github.com/ekailabs/contexto/discussions/114)

## Configuration

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `apiKey` | string | Yes | Your Contexto API key |
| `contextEnabled` | boolean | No | Enable or disable context retrieval (default: `true`) |
| `maxContextChars` | number | No | Maximum characters to inject as retrieved context |
| `compactThreshold` | number | No | Fraction of token budget that triggers compaction (default: `0.50`) |
| `compactionStrategy` | string | No | `"default"` or `"sliding-window"` (default: `"default"`) |
| `rlmEnabled` | boolean | No | Enable RLM tools for processing large contexts (default: `false`) |

## Large Context Processing (RLM)

When a user sends a message that exceeds 50% of the available token budget — a PDF, a spreadsheet, a massive log dump — the standard approach of stuffing it into the prompt breaks down. Contexto includes optional support for **Recursive Language Model (RLM)** processing to handle these cases.

When enabled, Contexto automatically detects oversized inputs, offloads them to an in-memory buffer, and gives the agent a set of six tools to explore, search, and reason over the content iteratively — without flooding the context window.

### Enabling RLM

Set `rlmEnabled` to `true` in your plugin config:

```bash
openclaw config set plugins.entries.contexto.config.rlmEnabled true
```

When disabled (the default), the plugin behaves exactly as before — no RLM tools are registered and no additional dependencies are loaded.

### How It Works

1. During context assembly, if the user's message exceeds 50% of the token budget, the content is moved to an in-memory **ContextBuffer** and the message is replaced with a brief instruction.
2. The agent receives six RLM tools: **rlm_overview**, **rlm_peek**, **rlm_grep**, **rlm_slice**, **rlm_query**, and **rlm_repl** — covering structural exploration, pattern search, targeted extraction, sub-LLM reasoning, and sandboxed scripting.
3. The agent iteratively explores and synthesizes an answer using these tools, keeping token usage bounded regardless of input size.
4. Once complete, the synthesized result is ingested into the mindmap as an episode, making it available for future recall just like any other conversation context.

RLM can also be invoked explicitly by the user, regardless of message size.

Sub-LLM calls are routed through [pi-ai](https://docs.openclaw.ai/pi) via OpenRouter's auto-routing, which automatically selects an appropriate model. No additional API keys or provider SDKs are needed beyond what OpenClaw already manages.

The RLM tools are provided by the [`@ekai/rlm`](../rlm/) package, which can also be used standalone outside of Contexto. See its [README](../rlm/README.md) for full tool documentation.

## Community

- [Discord](https://discord.gg/4QTRS5ew)
- [Discussions](https://github.com/ekailabs/contexto/discussions)
- [Issues](https://github.com/ekailabs/contexto/issues)

## License

Apache 2.0

---
