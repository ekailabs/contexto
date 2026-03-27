<p align="center">
  <h1 align="center">Contexto</h1>
  <p align="center"><strong>The Local-First Context Engine for AI Agents</strong></p>
  <p align="center">Neuroscience-inspired · Open source</p>
</p>

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub stars](https://img.shields.io/github/stars/ekailabs/contexto.svg?style=social)](https://github.com/ekailabs/contexto)
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?logo=discord&logoColor=white)](https://discord.com/invite/5VsUUEfbJk)


Persistent conversation memory today. Document knowledge and tool execution memory next.

Your conversations stay on your machine — no data sent to third-party memory services. Bring your own keys, run your own instance.

Start with the **OpenClaw plugin**, the **OpenAI-compatible proxy**, or the **memory SDK**.

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
```

### 2. Enable and configure the plugin

Set your API key via CLI:

```bash
openclaw plugins config @ekai/contexto apiKey your-api-key-here
```

### 3. Restart OpenClaw

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
Assistant: For your LangChain RAG pipeline — use RecursiveCharacterTextSplitter, 512 tokens,
         50-token overlap. It handles nested markdown and code blocks well.
```

## Three Pillars

Contexto's architecture is inspired by how human memory actually works — episodic memory (what happened), semantic memory (what you know), and procedural memory (how to do things). Instead of treating context as a flat key-value store, Contexto models these as distinct systems that work together.

| Pillar | What it does | Status |
| --- | --- | --- |
| 🧠 **Conversation Memory** | Episodic recall from past conversations. Your agent remembers what happened last Tuesday. | ✅ Live |
| 📚 **Document Knowledge** | Semantic knowledge from your documents, surfaced at the right time. No more re-uploading files. | 🚧 Coming soon |
| 🔧 **Tool Execution Memory** | Procedural memory from tool calls — what succeeded, what failed, what was retried. Agents get smarter with every execution. | 📋 Roadmap |

## Quick Start

### OpenClaw Plugin (recommended)

The fastest way to add persistent context to any OpenClaw agent:

Add to your OpenClaw config:

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
          "dbPath": "~/.openclaw/ekai/memory.db",
          "provider": "openai",
          "apiKey": "sk-..."
        }
      }
    }
  }
}
```

That's it. Your agent now remembers across conversations. Memory stays on your machine in a local SQLite DB — nothing leaves your device.

### Drop-in Proxy

Contexto speaks the OpenAI API format and routes through OpenRouter by default. Drop it in front of any compatible client — memory recall and injection happen automatically. (Automatic persistence currently requires the OpenClaw plugin or the memory SDK; proxy-side ingest is paused pending deduplication.)

```bash
npm install
cp .env.example .env       # add your OPENROUTER_API_KEY
npm run build && npm start
```

```bash
curl -X POST http://localhost:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic/claude-sonnet-4-5", "messages": [{"role": "user", "content": "Hello"}]}'
```

No code changes. No SDK. Just point your client at `localhost:4010`.

### Memory SDK

Use `@ekai/memory` directly in your own agent code. See [`memory/README.md`](memory/README.md) for the full API.

```ts
import { Memory } from '@ekai/memory';

const mem = new Memory({ provider: 'openai', apiKey: 'sk-...' });
mem.addAgent('my-bot', { name: 'My Bot' });

const bot = mem.agent('my-bot');
await bot.add(messages, { userId: 'alice' });
const memories = await bot.retrieve('What does Alice like?', { userId: 'alice' });
```

### Docker

```bash
cp .env.example .env       # add your OPENROUTER_API_KEY
docker compose up -d
```

**Default ports:** Proxy + memory APIs on `4010` · Dashboard on `3000`

## Memory Dashboard

Browse, search, and manage everything your agent remembers. Inspect the memories available for recall.

**→ `http://localhost:3000`**


## Why Contexto?

| | Typical alternatives | Contexto |
| --- | --- | --- |
| Where data lives | Cloud-hosted or server-based | Local SQLite — your machine, your file |
| Architecture | Flat key-value memory | Neuroscience-inspired (episodic, semantic, procedural) |
| Scope | Conversation memory only | Conversations today; documents + tool execution next |
| Integration | SDK required | Drop-in proxy, OpenClaw plugin, or memory SDK |
| Data sent to third parties | Often required | No third-party memory service — only your configured model provider |

## How It Works

```
                    ┌──────────────────────────────┐
                    │          Your Agent           │
                    │  (OpenClaw, Claude Code,      │
                    │   LangChain, custom, ...)     │
                    └──────────────┬───────────────┘
                                   │
                                   ▼
                    ┌──────────────────────────────┐
                    │           Contexto            │
                    │                              │
                    │  ┌────────┐ ┌─────┐ ┌──────┐ │
                    │  │Conver- │ │Doc  │ │Tool  │ │
                    │  │sation  │ │Know-│ │Exec  │ │
                    │  │Memory  │ │ledge│ │Memory│ │
                    │  └───┬────┘ └──┬──┘ └──┬───┘ │
                    │      └────┬────┘───────┘     │
                    │           ▼                  │
                    │   Unified Context Layer       │
                    └──────────────────────────────┘
```

## Project Structure

```
contexto/
├── packages/
│   ├── contexto/
│   │   ├── v0/              # Legacy @ekai/contexto (local memory)
│   │   └── v1/              # New @ekai/contexto (API-based mind map)
│   ├── memory/             # Core memory library (@ekai/memory)
│   ├── openrouter/         # Drop-in proxy with embedded memory
│   └── ui/dashboard/       # Memory dashboard (Next.js)
├── scripts/
│   └── launcher.js         # Unified service launcher
└── package.json
```

## Roadmap

- [x] Persistent conversation memory
- [x] OpenClaw plugin (`@ekai/contexto`)
- [x] Drop-in OpenAI-compatible proxy
- [x] Memory dashboard
- [ ] **Document knowledge** — ingestion, chunking, retrieval
- [ ] **Claude Code integration**
- [ ] **Tool execution memory** — learn from tool call successes and failures
- [ ] MCP server for universal agent integration
- [ ] Benchmarks on LOCOMO and agent task completion

## Configuration

| Variable | Description | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | Your OpenRouter API key | Required |
| `ENABLE_DASHBOARD` | Enable memory dashboard | `true` |
| `ENABLE_OPENROUTER` | Enable proxy + memory APIs | `true` |
| `OPENROUTER_PORT` | Proxy port | `4010` |
| `DASHBOARD_PORT` | Dashboard port | `3000` |

```bash
# Development (hot-reload)
npm run dev

# Production
npm start

# Individual services
ENABLE_DASHBOARD=false npm run dev      # proxy only
ENABLE_OPENROUTER=false npm run dev     # dashboard only
```

## Knowledge Base Retrieval

Contexto is designed as a **single install solution for all your context needs in OpenClaw**. 

Currently, the OpenClaw plugin supports retrieving context from local text and Markdown files (like Obsidian vaults) using QMD. By configuring a `knowledgeFolder` in your plugin settings, your agent can instantly reference external documentation, code snippets, or any static text-based information stored in that directory.

*Note: In the near future, we plan to extend Contexto to natively support fetching relevant context from other sources, including an upcoming integration with **Google Drive**!*

Unlike previous versions, this recursively discovers **any text file** (`.txt`, `.md`, `.json`, `.csv`, etc.) meaning everything in your folder is passed as direct context to your agent.

### Syncing with Obsidian 

If you use Obsidian to take notes and run the OpenClaw gateway on a remote VPS, you can instantly sync your Obsidian vault directly to your agent's `knowledgeFolder` via `obsidian-headless`:

1. **Install Obsidian Headless**
   ```bash
   npm install -g obsidian-headless
   ```
2. **Setup your Vault Folder**: On your VPS, create a folder for your remote vault and configure your `@ekai/contexto` plugin's `knowledgeFolder` settings to point there.
   ```bash
   mkdir -p ~/.openclaw/ekai/knowledge
   cd ~/.openclaw/ekai/knowledge
   ```
3. **Login & Sync**
   ```bash
   ob login
   ob sync-list-remote
   ob sync-setup --vault "Your Vault Name"
   ```
4. **Run Sync**
   - For a one-time sync: `ob sync`
   - To keep running continuously: `ob sync --continuous`

Whenever you update a note on your local Obsidian app, `ob sync` pulls it to your remote VPS, and Contexto instantly parses it for OpenClaw!

### How Retrieval Works

When a typical conversation request is processed, the standard knowledge flow is as follows:

1. **File Discovery:** It recursively scans your configured `knowledgeFolder` for all text-based files, skipping hidden files and binary files.
2. **Formatting:** It constructs a `## Reference Knowledge` context block, injecting the file contents and wrapping them in their respective extension types (e.g. ` ```md `, ` ```json `). This context block is prepended to the system prompt just before the final payload is sent to the LLM.
3. **Memory Recall:** Finally, it performs the standard long-term episodic conversation memory recall and appends those to the context alongside the document knowledge.

## Enterprise

Building AI agents for your team or product? We work with companies deploying agents at scale to ensure they always have the right context.

**→ [Talk to us](mailto:s@ekailabs.xyz)**

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md).

## Community

- 💬 [Discord](https://discord.com/invite/5VsUUEfbJk) — Chat with the team
- 📖 [Docs](https://docs.ekailabs.xyz/) — Documentation
- 🐛 [Issues](https://github.com/ekailabs/contexto/issues) — Bugs & feature requests

## License

Apache 2.0 — see [LICENSE](LICENSE).
