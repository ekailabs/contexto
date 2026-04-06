<p align="center">
  <h1 align="center">Contexto</h1>
  <p align="center"><strong>The Local-First Context Engine for AI Agents</strong></p>
  <p align="center">Neuroscience-inspired · Open source</p>
</p>

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub stars](https://img.shields.io/github/stars/ekailabs/contexto.svg?style=social)](https://github.com/ekailabs/contexto)
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?logo=discord&logoColor=white)](https://discord.com/invite/5VsUUEfbJk)


AI agents face a fundamental problem: **context windows are finite, but conversations are not.** Most runtimes handle this by summarizing older messages to free space. This works for short conversations, but over time summaries compound into summaries-of-summaries, blending unrelated topics and losing specific details.

Contexto takes a different approach: instead of compressing history, it **organizes** it.

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

### 4. Restart OpenClaw

```bash
openclaw gateway restart
```

## Configuration

| Property | Type | Required | Description |
| --- | --- | --- | --- |
| `apiKey` | string | Yes | Your Contexto API key |

## See the Difference

**Without Contexto:**
```
User: I prefer concise answers. I'm building a RAG pipeline with LangChain.

[new session]

User: How should I chunk my documents?
Assistant: Great question! There are many approaches to document chunking. First, let me explain
         what chunking is...
```

**With Contexto:**
```
Retrieved context:
  → user prefers concise answers
  → user is building a RAG pipeline with LangChain

User: How should I chunk my documents?
Assistant: For your LangChain RAG pipeline: use RecursiveCharacterTextSplitter, 512 tokens,
         50-token overlap. It handles nested markdown and code blocks well.
```

## Quick Start

### OpenClaw Plugin

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "@ekai/contexto"
    },
    "allow": ["@ekai/contexto"],
    "entries": {
      "@ekai/contexto": {
        "enabled": true,
        "config": {
          "apiKey": "your-api-key"
        }
      }
    }
  }
}
```

Or via CLI:

```bash
openclaw plugins install @ekai/contexto
openclaw plugins enable contexto
openclaw config set plugins.slots.contextEngine contexto
openclaw config set plugins.entries.contexto.config.apiKey your-api-key
openclaw gateway restart
```

## How It Works

### Episodes and the Sliding Window

The unit of storage is an **episode**: a full conversation turn containing the user message, assistant response, and any tool outputs. The sliding-window engine buffers episodes in memory. When token usage hits the compact threshold (default 50% of the token budget), the oldest episodes are ingested to the backend and evicted from the context window.

### Hierarchical Clustering (AGNES)

Contexto organizes episodes using [AGNES (Agglomerative Nesting)](https://onlinelibrary.wiley.com/doi/book/10.1002/9780470316801), a bottom-up hierarchical clustering algorithm paired with [average linkage (UPGMA)](https://www.semanticscholar.org/paper/A-statistical-method-for-evaluating-systematic-Sokal-Michener/0db093335bc3b9445fa5a1a5526d634921d7b59a) via [`ml-hclust`](https://github.com/mljs/hclust).

```
Episode turns (with embeddings)
  -> Pairwise cosine distance matrix
  -> AGNES with average linkage
  -> Dendrogram
  -> Cut at similarity threshold (0.65)
  -> ClusterNode tree (max depth 4)
```

Unlike summary-based compaction, the hierarchy preserves full episodes and gives you:

- **Semantic organization**: related episodes land in the same branch, even if they happened weeks apart
- **Multi-resolution retrieval**: match a top-level branch (all travel episodes) or drill into a sub-cluster (visa documents only)
- **No pre-defined categories**: topics emerge from embeddings, no taxonomy required
- **No information loss**: full episodes are stored and retrievable, never compressed

For the full technical deep dive, see [Why We Chose Hierarchical Clustering](docs/why-agnes.md).

### Multi-Branch Beam Search

Retrieval uses beam search (width 3) to explore multiple promising branches simultaneously. Instead of returning the top-k most similar items, beam search descends into the most relevant topic branches and greedily fills the token budget. When a query spans multiple topics, it surfaces episodes from several branches in a single pass with full path tracing for explainability (e.g., `travel -> Japan trip -> visa documents`).

### Hybrid Rebuild Strategy

Full AGNES is O(n^2) and only runs periodically: when items are below 100 or after 50 incremental inserts. Between rebuilds, new episodes insert in O(log N) by walking the tree and slotting into the best-matching branch.

## Why Not Just Summarize?

| | Summary-Based Compaction | Contexto (Hierarchical Clustering) |
|---|---|---|
| **What happens at compaction** | Oldest messages summarized into a shorter block | Episodes ingested into a semantic tree, originals evicted |
| **Information loss** | Compounds over time (summaries of summaries) | None. Full episodes stored and retrievable |
| **Cross-topic handling** | Unrelated episodes blended into one summary | Related episodes cluster together, unrelated stay separate |
| **Retrieval** | Whatever the summary retained | Beam search across relevant topic branches |
| **Token budget** | Summary must fit alongside new messages | Retrieval fills budget with the most relevant episodes |

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Your Agent                    │
│  (OpenClaw, Claude Code, LangChain, custom, ...)│
└──────────────────────┬──────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────┐
│              @ekai/contexto                     │
│         Sliding Window + Compaction             │
│                                                 │
│   Episodes buffered -> compact at threshold     │
│   -> evict oldest -> ingest to backend          │
└──────────────────────┬──────────────────────────┘
                       │  ContextoBackend interface
                       v
┌─────────────────────────────────────────────────┐
│         Remote API  or  Custom Backend          │
│         (api.getcontexto.com)                   │
└──────────────────────┬──────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────┐
│              @ekai/mindmap                      │
│   AGNES Clustering + Beam Search Retrieval      │
│                                                 │
│   Episodes -> semantic tree -> query via beam   │
│   search -> token-budget-aware results          │
└─────────────────────────────────────────────────┘
```

## Pluggable Backend

The context engine communicates with backends through the `ContextoBackend` interface:

```ts
interface ContextoBackend {
  /** Store one or more conversation events. */
  ingest(payload: WebhookPayload | WebhookPayload[]): Promise<void>;
  /** Search the mindmap for context relevant to the query. */
  search(query: string, maxResults: number, filter?: Record<string, unknown>, minScore?: number): Promise<SearchResult | null>;
}
```

The default `RemoteBackend` calls the hosted API at `api.getcontexto.com`. Implement the `ContextoBackend` interface to plug in your own storage and retrieval backend.

## Packages

```
contexto/
├── packages/
│   ├── contexto/         # @ekai/contexto — OpenClaw plugin, context engine
│   ├── mindmap/          # @ekai/mindmap — AGNES clustering + beam search
│   ├── memory/           # @ekai/memory — SQLite-backed memory kernel
│   ├── openrouter/       # @ekai/openrouter — OpenAI-compatible proxy
│   └── ui/dashboard/     # @ekai/ui-dashboard — Next.js monitoring dashboard
├── docs/                 # Technical documentation
├── CONTRIBUTING.md
└── package.json
```

## Configuration

| Property | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `apiKey` | string | Yes | | Your Contexto API key |
| `compactionStrategy` | `'sliding-window'` \| `'default'` | No | `'sliding-window'` | Compaction strategy |
| `compactThreshold` | number (0-1) | No | `0.50` | Ingest + evict at this % of token budget |
| `contextEnabled` | boolean | No | `true` | Enable/disable context injection |
| `maxContextChars` | number | No | | Max characters for injected context |
| `minScore` | number | No | | Minimum similarity score for retrieved results |

## Roadmap

- [x] OpenClaw plugin (`@ekai/contexto`)
- [x] Hierarchical clustering with AGNES (`@ekai/mindmap`)
- [x] Multi-branch beam search retrieval
- [ ] RLM Plugin
- [ ] **Document knowledge** — ingestion, chunking, retrieval
- [ ] **Claude Code integration**
- [ ] Benchmarks

## Enterprise

Building AI agents for your team or product? We work with companies deploying agents at scale to ensure they always have the right context.

**[Talk to us](mailto:s@ekailabs.xyz)**

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## Community

- 💬 [Discord](https://discord.com/invite/5VsUUEfbJk) — Chat with the team
- 📖 [Docs](https://docs.ekailabs.xyz/) — Documentation
- 🐛 [Issues](https://github.com/ekailabs/contexto/issues) — Bugs & feature requests

## License

Apache 2.0 — see [LICENSE](LICENSE).
