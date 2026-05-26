# Memory

Agent-centric, local-first semantic memory. Your agent reflects on conversations and decides what to learn -- memory is first-person, not a passive database about users.

## SDK / HTTP API

### Install

```bash
npm install @ekai/memory
```

### SDK Quickstart

```ts
import { Memory } from '@ekai/memory';

const mem = new Memory({ provider: 'openai', apiKey: 'sk-...' });

// Register agents
mem.addAgent('my-bot', { name: 'My Bot', soul: 'You are helpful' });
mem.addAgent('chef-bot', { name: 'Chef', relevancePrompt: 'Only store memories about cooking' });

// Scope to an agent for data ops
const bot = mem.agent('my-bot');

// Ingest conversation
await bot.add(messages, { userId: 'alice' });

// Search memories
const results = await bot.search('preferences', { userId: 'alice' });

// Browse
bot.users();                            // agent's known users
bot.memories();                         // all agent memories
bot.memories({ userId: 'alice' });      // memories about alice
bot.memories({ scope: 'global' });      // non-user-scoped memories

// Delete
bot.delete(id);
```

### Mountable Router

Mount memory endpoints into an existing Express app:

```ts
import { Memory, createMemoryRouter } from '@ekai/memory';

const memory = new Memory({ provider: 'openai', apiKey: 'sk-...' });
app.use(createMemoryRouter(memory._store, memory._extractFn));
```

### Standalone Server

Run memory as its own HTTP service:

```bash
npm run start -w @ekai/memory
# Memory service listening on :4005
```

### Key API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/ingest` | Ingest conversation messages |
| POST | `/v1/search` | Search with semantic gating |
| GET | `/v1/summary` | Sector counts + recent memories |
| GET/POST | `/v1/agents` | List / create agents |
| GET/PUT/DELETE | `/v1/agents/:slug` | Get / update / delete agent |
| PUT/DELETE | `/v1/memory/:id` | Update / delete a memory |
| DELETE | `/v1/memory` | Delete all memories for agent |
| GET | `/v1/users` | List agent's known users |
| GET | `/v1/users/:id/memories` | User-scoped memories |
| GET | `/v1/graph/triples` | Query semantic triples |
| GET | `/v1/graph/visualization` | Graph visualization data |

All endpoints accept an `agent` query/body param. Full API reference: [`packages/memory/README.md`](../packages/memory/README.md).

---

## Configuration Reference

### Constructor / SDK

| Param | Default | Description |
|-------|---------|-------------|
| `provider` | env-based | LLM provider: `gemini`, `openai`, or `openrouter` |
| `apiKey` | env-based | API key for the selected provider |
| `dbPath` | `./memory.db` | Path to SQLite memory file |
| `embedModel` | provider default | Override embedding model |
| `extractModel` | provider default | Override extraction model |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_API_KEY` | — | Required if using Gemini provider |
| `OPENAI_API_KEY` | — | Required if using OpenAI provider |
| `OPENROUTER_API_KEY` | — | Required if using OpenRouter provider |
| `MEMORY_EMBED_PROVIDER` | `gemini` | Embedding provider |
| `MEMORY_EXTRACT_PROVIDER` | `gemini` | Extraction provider |
| `MEMORY_DB_PATH` | `./memory.db` | SQLite file path |
| `MEMORY_PORT` | `4005` | Standalone server port |
| `MEMORY_CORS_ORIGIN` | `*` | CORS origins (standalone mode) |

### Supported Providers

| Provider | Embed Model (default) | Extract Model (default) |
|----------|----------------------|------------------------|
| `gemini` | Gemini embedding | Gemini generation |
| `openai` | OpenAI embedding | OpenAI generation |
| `openrouter` | OpenRouter embedding | OpenRouter generation |

---

## Memory Sectors

The agent extracts memories into four sectors:

| Sector | What it stores | Example |
|--------|---------------|---------|
| **Episodic** | Events, conversations | "I discussed architecture with Sha on Monday" |
| **Semantic** | Facts as subject/predicate/object triples | `Sha / prefers / dark mode` |
| **Procedural** | Multi-step workflows | "When deploying: test -> build -> push" |
| **Reflective** | Agent self-observations | "I tend to overcomplicate solutions" |

---

## User Scoping

Pass `userId` when ingesting or searching to scope memories per-user. Omit it for shared/global memories.

Semantic triples are tagged with a domain — `user`, `world`, or `self`. User-domain facts (e.g., "Sha prefers dark mode") are only returned when that `userId` is passed. World and self facts are shared across all users.

---

For the full data model, retrieval pipeline, and consolidation details, see [`packages/memory/README.md`](../packages/memory/README.md).
