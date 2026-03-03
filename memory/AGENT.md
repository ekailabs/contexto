# AGENT.md — Memory Service (Ekai)

> Guide for AI agents working on the memory service codebase.

## 1. Overview

The memory service is a **neuroscience-inspired cognitive memory system** that runs as a standalone Express server (default port `4005`). It provides three memory sectors — episodic, semantic, and procedural — with PBWM-inspired scoring for retrieval gating and semantic fact consolidation for knowledge graph maintenance.

### Key Features
- **3 memory sectors**: episodic (events), semantic (knowledge graph triples), procedural (step-by-step workflows)
- **PBWM gating**: Prefrontal–basal-ganglia-inspired scoring with relevance, expected value, control signal, and noise
- **Semantic consolidation**: Merge/supersede/insert logic for knowledge graph facts using embedding similarity
- **Working memory cap**: Gate threshold of 0.5, hard cap of 8 items
- **Multi-profile support**: Isolated memory spaces per profile slug
- **Dual provider support**: Gemini (default) and OpenAI for embeddings and extraction

### Architecture Summary

```
POST /v1/ingest           → extract(LLM) → 3 sectors → embed → SQLite
POST /v1/ingest/documents → read .md files → chunk → extract → dedup → store with source
POST /v1/search           → embed query → brute-force cosine → PBWM gate → working memory (cap 8)
GET  /v1/graph/*          → BFS traversal over semantic_memory triples
```

---

## 2. Quick Reference

### Directory Structure

```
memory/
├── package.json           # ESM package; scripts: build, start, prestart
├── tsconfig.json          # ESNext target, strict: false, output → ./dist
├── memory.db              # SQLite database (runtime artifact, gitignored)
├── README.md              # User-facing documentation
├── AGENT.md               # This file
└── src/
    ├── index.ts            # Barrel re-export of all modules
    ├── server.ts           # Express app, all route definitions, env loading
    ├── sqlite-store.ts     # Core storage: schema, ingest, query, CRUD
    ├── documents.ts        # Document ingestion: markdown chunking + orchestration
    ├── types.ts            # All TypeScript interfaces and type aliases
    ├── scoring.ts          # PBWM gate scoring algorithm
    ├── wm.ts               # Working memory filter and cap logic
    ├── consolidation.ts    # Semantic fact consolidation (merge/supersede/insert)
    ├── semantic-graph.ts   # Graph traversal (BFS paths, neighbors, reachability)
    ├── utils.ts            # cosine similarity, sigmoid, gaussian noise, profile slug
    └── providers/
        ├── registry.ts     # Provider config, URL builder, auth for Gemini/OpenAI
        ├── embed.ts        # Embedding API caller
        ├── extract.ts      # LLM-based memory extraction (structured JSON)
        └── prompt.ts       # System prompt for the extraction LLM
```

### Build & Run

```bash
# Install dependencies (from repo root)
npm install -w memory

# Build TypeScript
npm run build -w memory

# Start server (runs prestart → build automatically)
npm start -w memory

# Run all services together (gateway + dashboard + memory)
npm run dev:all
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GOOGLE_API_KEY` | *required* | Gemini API key for extraction and embeddings |
| `MEMORY_PORT` | `4005` | HTTP server port |
| `MEMORY_DB_PATH` | `./memory.db` | SQLite database file path |
| `MEMORY_CORS_ORIGIN` | `*` | Comma-separated allowed CORS origins |
| `MEMORY_EMBED_PROVIDER` | `gemini` | Embedding provider: `gemini` or `openai` |
| `MEMORY_EXTRACT_PROVIDER` | `gemini` | Extraction provider: `gemini` or `openai` |
| `GEMINI_EMBED_MODEL` | `gemini-embedding-001` | Gemini embedding model |
| `GEMINI_EXTRACT_MODEL` | `gemini-2.5-flash` | Gemini extraction model |
| `OPENAI_API_KEY` | — | Required if using OpenAI provider |
| `OPENAI_EMBED_MODEL` | `text-embedding-3-small` | OpenAI embedding model |
| `OPENAI_EXTRACT_MODEL` | `gpt-4o-mini` | OpenAI extraction model |

Env files are loaded from `memory/.env` first, then root `.env` (see `server.ts:7-8`).

### API Endpoints at a Glance

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Health check |
| `GET` | `/v1/profiles` | List all profiles |
| `DELETE` | `/v1/profiles/:slug` | Delete a profile and all its memories |
| `POST` | `/v1/ingest` | Ingest experience → extract → embed → store |
| `POST` | `/v1/ingest/documents` | Ingest markdown files from a directory with dedup |
| `POST` | `/v1/search` | Search memories with PBWM-gated retrieval |
| `GET` | `/v1/summary` | Per-sector counts + recent items |
| `PUT` | `/v1/memory/:id` | Update a memory's content |
| `DELETE` | `/v1/memory/:id` | Delete a single memory |
| `DELETE` | `/v1/memory` | Delete all memories for a profile |
| `DELETE` | `/v1/graph/triple/:id` | Delete a semantic triple |
| `GET` | `/v1/graph/triples` | Query triples by entity |
| `GET` | `/v1/graph/neighbors` | Get connected entities |
| `GET` | `/v1/graph/paths` | BFS path-finding between entities |
| `GET` | `/v1/graph/visualization` | Graph data for UI rendering |

---

## 3. Core Concepts

### 3a. Three Memory Sectors

Each sector models a distinct cognitive function. The extraction LLM (`providers/prompt.ts`) classifies incoming text into these sectors.

**Episodic** — Past events and experiences with temporal context.
- Stored in `memory` table with `sector = 'episodic'`
- `event_start` set to ingestion time; `event_end` nullable
- Example: `"User attended a React conference in Berlin last March"`

**Semantic** — Stable, context-free facts as subject-predicate-object triples.
- Stored in `semantic_memory` table (separate schema)
- Knowledge graph structure with consolidation
- Example: `{ subject: "User", predicate: "works at", object: "Anthropic" }`

**Procedural** — Multi-step workflows with trigger, goal, steps, result, context.
- Stored in `procedural_memory` table
- Embedded on the `trigger` field
- Example: `{ trigger: "deploy to production", goal: "ship new release", steps: ["run tests", "build docker image", "push to registry", "kubectl apply"], result: "deployment complete" }`

**Extraction rules** (from `prompt.ts`):
- "I" is rewritten as "User"
- Personal facts about the user (identity, relationships, preferences-as-facts, likes/dislikes) go to **semantic** as triples
- Only valid JSON is returned; empty fields use `""` or `{}`

### 3b. PBWM Scoring

Defined in `scoring.ts`. The Prefrontal-Basal-ganglia Working Memory model gates which memories enter working memory.

**Constants** (`scoring.ts:4-15`):
```
RETRIEVAL_SOFTCAP = 10
RELEVANCE_WEIGHT  = 1.0
EXPECTED_VALUE_WEIGHT = 0.4
CONTROL_WEIGHT    = 0.05
NOISE_WEIGHT      = 0.02
CONTROL_SIGNAL    = 0.3  (fixed)
```

**Formula** (`scoreRowPBWM`, `scoring.ts:22-53`):
```
relevance     = cosineSimilarity(queryEmbedding, row.embedding)
expectedValue = normalizeRetrieval(row)   // log-normalized retrieval_count
noise         = gaussianNoise(mean=0, std=0.05)

x = 1.0 * relevance + 0.4 * expectedValue + 0.05 * 0.3 - 0.02 * noise
gateScore = sigmoid(x)
score = gateScore * sectorWeight
```

**`normalizeRetrieval`** (`scoring.ts:57-61`):
```
retrievalScore = count > 0 ? log(1 + count) / log(1 + 10) : 0
return min(1, retrievalScore)
```

### 3c. Working Memory Gating

Defined in `wm.ts:3-20`.

```
PBWM_GATE_THRESHOLD = 0.5
WM_CAP = 8
```

Pipeline:
1. Flatten all per-sector results into a single array
2. Filter: keep only items where `gateScore > 0.5`
3. Sort descending by `gateScore`
4. Slice to top 8 items

### 3d. Semantic Consolidation

Defined in `consolidation.ts:23-43`, orchestrated in `sqlite-store.ts:166-217`.

When a new semantic fact `{subject, predicate, object}` is ingested:

1. **Find active facts**: Query all non-expired facts for the same subject (`sqlite-store.ts:632-648`)
2. **Semantic predicate matching**: Embed the new predicate and each existing predicate; match if cosine similarity >= 0.9 (`sqlite-store.ts:654-696`). This lets `"is co-founder of"` match `"cofounded"`.
3. **Determine action** (`consolidation.ts:23-43`):
   - **No existing facts** → `insert` (new fact)
   - **Exact object match** (case-insensitive) → `merge` (skip, add source attribution)
   - **Different object** → `supersede` (close old fact by setting `valid_to = now`, then insert new)

### 3e. Multi-Profile System

- Each memory is associated with a `profile_id` (default: `'default'`)
- Profile slugs are normalized: lowercase, validated against `/^[a-z0-9_-]{1,40}$/` (`utils.ts:32-41`)
- The `profiles` table tracks known slugs and backfills from existing data on startup
- The `default` profile cannot be deleted (protected in `server.ts:55`)
- Profile parameter accepted as `profile` or `profileId` in request body/query params

---

## 4. Data Layer

### Database Schema

All DDL in `SqliteMemoryStore.prepareSchema()` (`sqlite-store.ts:550-611`) with migrations at lines 615-777.

#### `memory` table (`sqlite-store.ts:552-568`)

For episodic memories.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text | PRIMARY KEY (crypto.randomUUID) |
| `sector` | text | NOT NULL — `'episodic'` |
| `content` | text | NOT NULL |
| `embedding` | json | NOT NULL — float array |
| `created_at` | integer | NOT NULL — Unix ms |
| `last_accessed` | integer | NOT NULL — Unix ms |
| `event_start` | integer | nullable — episodic only |
| `event_end` | integer | nullable |
| `retrieval_count` | integer | NOT NULL DEFAULT 0 |
| `profile_id` | text | NOT NULL DEFAULT 'default' |
| `source` | text | DEFAULT NULL — relative file path for document-ingested memories |

Indexes: `idx_memory_sector`, `idx_memory_last_accessed`, `idx_memory_profile_sector`

#### `procedural_memory` table (`sqlite-store.ts:570-586`)

| Column | Type | Notes |
|--------|------|-------|
| `id` | text | PRIMARY KEY |
| `trigger` | text | NOT NULL — what activates this procedure |
| `goal` | text | nullable |
| `context` | text | nullable |
| `result` | text | nullable |
| `steps` | json | NOT NULL — string array |
| `embedding` | json | NOT NULL — embedded on `trigger` |
| `created_at` | integer | NOT NULL |
| `last_accessed` | integer | NOT NULL |
| `profile_id` | text | NOT NULL DEFAULT 'default' |
| `source` | text | DEFAULT NULL — relative file path for document-ingested memories |

Indexes: `idx_proc_last_accessed`, `idx_proc_profile`

#### `semantic_memory` table (`sqlite-store.ts:588-606`)

Knowledge graph triples with temporal validity.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text | PRIMARY KEY |
| `subject` | text | NOT NULL |
| `predicate` | text | NOT NULL |
| `object` | text | NOT NULL |
| `valid_from` | integer | NOT NULL — Unix ms |
| `valid_to` | integer | nullable — null = currently active |
| `created_at` | integer | NOT NULL |
| `updated_at` | integer | NOT NULL |
| `embedding` | json | NOT NULL — embedded on `"subject predicate object"` |
| `metadata` | json | nullable |
| `profile_id` | text | NOT NULL DEFAULT 'default' |
| `source` | text | DEFAULT NULL — relative file path for document-ingested memories |

Indexes: `idx_semantic_subject_pred`, `idx_semantic_object`, `idx_semantic_profile`, `idx_semantic_slot`

#### `profiles` table (`sqlite-store.ts:757-764`)

| Column | Type | Notes |
|--------|------|-------|
| `slug` | text | PRIMARY KEY |
| `created_at` | integer | NOT NULL |

### Embedding Strategy

All sectors use the same embedding model (the `_sector` param in `embed()` is accepted but unused — `embed.ts:4`).

| Sector | Text embedded |
|--------|--------------|
| Episodic | Full `content` string |
| Procedural | `trigger` field only |
| Semantic | `"subject predicate object"` concatenation |

### Key Constants (`sqlite-store.ts:19-29`)

```typescript
const SECTORS: SectorName[] = ['episodic', 'semantic', 'procedural'];
const PER_SECTOR_K = 4;           // Top-k results per sector
const WORKING_MEMORY_CAP = 8;     // Max items in working memory
const SECTOR_SCAN_LIMIT = 200;    // Max rows scanned per sector (brute-force)
const DEFAULT_RETRIEVAL_COUNT = 0;
```

Additional thresholds:
- Cosine similarity minimum for candidates: `0.2` (`sqlite-store.ts:293`)
- Semantic predicate matching threshold: `0.9` (`sqlite-store.ts:173`)

---

## 5. Code Architecture

### Entry Points

- **`server.ts`** — Express HTTP server. Loads env, creates `SqliteMemoryStore`, defines all routes, starts listening on `MEMORY_PORT`. This is the runtime entry point (`npm start` runs `node dist/server.js`).
- **`index.ts`** — Barrel file that re-exports all modules. Used when importing the memory service as a library from the workspace.

### Provider System (`providers/`)

The provider layer abstracts LLM and embedding API calls behind a two-provider registry.

**`registry.ts`** — Provider configuration and URL construction:
- `resolveProvider(kind)`: Checks `MEMORY_EMBED_PROVIDER` or `MEMORY_EXTRACT_PROVIDER` env var; defaults to `'gemini'`
- `getModel(cfg, kind)`: Checks model env overrides, falls back to defaults
- `buildUrl(cfg, kind, model, apiKey)`: Constructs full URL; Gemini uses `?key=` auth, OpenAI uses `Bearer` header

**`embed.ts`** — `embed(text, sector) → number[]`:
- Gemini: `POST {model, content: {parts: [{text}]}}` → `response.embedding.values`
- OpenAI: `POST {model, input: text}` → `response.data[0].embedding`

**`extract.ts`** — `extract(text) → IngestComponents`:
- Gemini: `POST {contents, generationConfig: {temperature: 0, responseMimeType: 'application/json'}}`
- OpenAI: `POST {messages, temperature: 0, response_format: {type: 'json_object'}}`
- Returns `{episodic?, semantic?, procedural?}`

**`prompt.ts`** — System prompt instructing the LLM to classify text into the three memory sectors.

### Core Modules

**`sqlite-store.ts`** — The largest module. Class `SqliteMemoryStore`:
- `prepareSchema()` — DDL + migrations (including `ensureSourceColumn()`)
- `ingest(components, profile, options?)` — Main ingest pipeline; handles all 3 sectors + consolidation. When `options.deduplicate` is true, skips near-duplicate memories (cosine > 0.9) and skips strength bumps on semantic merges.
- `search(query, profile)` — Retrieval pipeline; embed → cosine filter → PBWM score → top-k → working memory
- `updateMemory(id, content, profile)` — Re-embeds and updates `memory` table rows
- `deleteMemory(id, profile)` — Deletes across all 3 tables
- `getSummary(limit, profile)` — UNION ALL across tables for dashboard
- `getAvailableProfiles()` / `deleteProfile(slug)` — Profile CRUD
- Graph helpers: `findActiveFactsForSubject()`, `findSemanticallyMatchingFacts()`, `supersedeFact()`
- Dedup helpers: `findDuplicateMemory()`, `findDuplicateProcedural()`, `setMemorySource()`, `setProceduralSource()`, `setSemanticSource()`

**`documents.ts`** — Document ingestion module:
- `chunkMarkdown(content, filePath)` — Strips YAML frontmatter, splits on `#{1,3}` headings, sub-splits at `\n\n` if > 12K chars. Returns `Array<{ text, source, index }>`.
- `ingestDocuments(dirPath, store, profile)` — Reads `.md` files recursively, chunks each, extracts via LLM, stores with `{ source, deduplicate: true }`. Returns `{ ingested, chunks, stored, skipped, errors, profile }`.

**`scoring.ts`** — `scoreRowPBWM(row, queryEmbedding, sectorWeight)` — PBWM gate scoring

**`wm.ts`** — `filterAndCapWorkingMemory(perSector, cap)` — Gate threshold filter + cap

**`consolidation.ts`** — `determineConsolidationAction(newFact, existingFacts)` — Merge/supersede/insert decision

**`semantic-graph.ts`** — Class `SemanticGraphTraversal`:
- `findTriplesBySubject(subject, options)` / `findTriplesByObject(object, options)`
- `findConnectedTriples(entity, options)` — Union of subject + object queries
- `findReachableEntities(entity, options)` — BFS reachability (default maxDepth=2)

**`utils.ts`** — Math primitives and profile normalization:
- `cosineSimilarity(a, b)` — Dot product / (|a| * |b|)
- `sigmoid(x)` — 1 / (1 + exp(-x))
- `gaussianNoise(mean, std)` — Box-Muller transform
- `normalizeProfileSlug(profile)` — Validates and normalizes to lowercase slug

### Ingest Data Flow

```
POST /v1/ingest { messages, profile }
  │
  ├─ Validate: ≥1 user message with content (server.ts:105-111)
  ├─ Concatenate: sourceText = userMessages.map(m => m.content).join('\n\n')
  ├─ extract(sourceText) → LLM → { episodic, semantic, procedural }
  │
  └─ store.ingest(components, profile) (sqlite-store.ts:45-235)
       │
       ├─ episodic → embed(content) → INSERT into memory
       │
       ├─ procedural → normalize to {trigger, steps, ...} → embed(trigger) → INSERT into procedural_memory
       │
       └─ semantic → normalize to {subject, predicate, object}
            ├─ embed("subject predicate object") → embedding
            ├─ findActiveFactsForSubject(subject, profile)
            ├─ findSemanticallyMatchingFacts(predicate, facts, threshold=0.9)
            ├─ determineConsolidationAction(newFact, matchingFacts)
            │    ├─ merge → skip (add source attribution)
            │    ├─ supersede → supersedeFact(targetId) + INSERT new
            │    └─ insert → INSERT new
            └─ INSERT into semantic_memory (if not merge)
```

### Document Ingestion Data Flow

```
POST /v1/ingest/documents { path, profile }
  │
  ├─ Validate: path exists (file or directory)
  ├─ collectMarkdownFiles(path) — recursive, sorted alphabetically
  │
  └─ For each .md file:
       ├─ Read file, skip if empty
       ├─ chunkMarkdown(content, relativePath)
       │    ├─ Strip YAML frontmatter
       │    ├─ Split on #{1,3} headings
       │    └─ Sub-split at \n\n if section > 12K chars
       │
       └─ For each chunk:
            ├─ extract(chunk.text) → IngestComponents
            └─ store.ingest(components, profile, { source: relativePath, deduplicate: true })
                 │
                 ├─ Episodic: embed → findDuplicateMemory (cosine > 0.9)
                 │    ├─ Duplicate found → skip (add source attribution to existing)
                 │    └─ No duplicate → INSERT with source
                 │
                 ├─ Semantic: consolidation as normal, on merge → add source attribution
                 │
                 └─ Procedural: embed trigger → findDuplicateProcedural (cosine > 0.9)
                      ├─ Duplicate found → skip (add source attribution to existing)
                      └─ No duplicate → INSERT with source

  Return { ingested, chunks, stored, skipped, errors, profile }
```

### Retrieval Data Flow

```
POST /v1/search { query, profile }
  │
  ├─ For each sector: queryEmbeddings[sector] = embed(query, sector)
  │
  ├─ For each sector: load candidates (up to SECTOR_SCAN_LIMIT=200)
  │    ├─ episodic: SELECT from memory WHERE sector=? AND profile_id=?
  │    ├─ procedural: SELECT from procedural_memory (content = trigger)
  │    └─ semantic: SELECT from semantic_memory WHERE (valid_to IS NULL OR valid_to > now)
  │                 content = "subject predicate object"
  │
  ├─ Filter: cosineSimilarity ≥ 0.2
  │
  ├─ Score: scoreRowPBWM(row, queryEmbedding, sectorWeight=1.0)
  │
  ├─ Sort by gateScore DESC → take top PER_SECTOR_K=4 per sector
  │
  ├─ Touch: update last_accessed for returned rows
  │
  ├─ filterAndCapWorkingMemory(perSector, cap=8)
  │    ├─ Flatten all sectors
  │    ├─ Filter: gateScore > 0.5
  │    ├─ Sort DESC → slice to 8
  │    └─ Bump retrieval_count for working memory entries
  │
  └─ Return { workingMemory, perSector, profileId }
```

---

## 6. API Documentation

### `POST /v1/ingest`

Ingest an experience. Extracts memories via LLM, embeds, and stores.

**Request:**
```json
{
  "messages": [
    { "role": "user", "content": "I just started working at Anthropic as a senior engineer" },
    { "role": "assistant", "content": "Congratulations on the new role!" }
  ],
  "profile": "alice",
  "reasoning": "optional, currently unused",
  "feedback": { "type": "success", "value": 1 },
  "metadata": {}
}
```

**Validation:** At least one message with `role: 'user'` and non-empty `content`.

**Response:**
```json
{ "stored": 3, "ids": ["uuid-1", "uuid-2", "uuid-3"], "profile": "alice" }
```

### `POST /v1/ingest/documents`

Ingest markdown files from a directory (or single file). Chunks by headings, extracts memories via LLM, stores with deduplication and source attribution. Safe to re-run — duplicates are skipped.

**Request:**
```json
{ "path": "/path/to/markdown/folder", "profile": "project-x" }
```

**Validation:** `path` is required and must exist on disk. Can be a directory or a single `.md` file.

**Response:**
```json
{
  "ingested": 5,
  "chunks": 18,
  "stored": 31,
  "skipped": 4,
  "errors": ["notes/broken.md[2]: extraction failed"],
  "profile": "project-x"
}
```

**Errors:** `400 path_required`, `400 path_not_found`, `400 invalid_profile`

**Deduplication strategy:**
- **Episodic**: Embed content, compare against existing rows for same sector+profile. Skip if cosine similarity > 0.9.
- **Semantic**: Uses existing consolidation. On merge (same subject+predicate+object), adds source attribution to existing fact.
- **Procedural**: Embed trigger, compare against existing procedural rows. Skip if cosine similarity > 0.9.

### `POST /v1/search`

Search memories with PBWM-gated retrieval.

**Request:**
```json
{ "query": "Where does the user work?", "profile": "alice" }
```

**Response:**
```json
{
  "workingMemory": [
    {
      "sector": "semantic", "id": "uuid-1", "profileId": "alice",
      "content": "User works at Anthropic", "score": 0.87,
      "similarity": 0.92, "decay": 1, "createdAt": 1700000000000,
      "lastAccessed": 1700000050000
    }
  ],
  "perSector": {
    "episodic": [...],
    "semantic": [...],
    "procedural": []
  },
  "profileId": "alice"
}
```

### `GET /v1/summary`

**Query params:** `limit` (default 50), `profile` / `profileId`

**Response:**
```json
{
  "summary": [
    { "sector": "episodic", "count": 5, "lastCreatedAt": 1700000000000 },
    { "sector": "semantic", "count": 12, "lastCreatedAt": 1700000000000 },
    { "sector": "procedural", "count": 2, "lastCreatedAt": 1700000000000 }
  ],
  "recent": [
    {
      "id": "uuid-1", "sector": "semantic", "profile": "default",
      "createdAt": 1700000000000, "lastAccessed": 1700000000000,
      "preview": "User works at Anthropic", "retrievalCount": 3,
      "details": { "subject": "User", "predicate": "works at", "object": "Anthropic" }
    }
  ],
  "profile": "default"
}
```

### `PUT /v1/memory/:id`

Update a memory's content (re-embeds automatically). Only works on `memory` table rows (episodic).

**Request:**
```json
{ "content": "Updated memory text", "profile": "alice" }
```

**Response:** `{ "updated": true, "id": "uuid-1", "profile": "alice" }`

### `DELETE /v1/memory/:id`

Delete a single memory from any table. **Query params:** `profile` / `profileId`

**Response:** `{ "deleted": 1, "profile": "alice" }`

### `DELETE /v1/memory`

Bulk delete all memories for a profile. **Query params:** `profile` / `profileId`

**Response:** `{ "deleted": 22, "profile": "alice" }`

### `GET /v1/profiles`

**Response:** `{ "profiles": ["alice", "bob", "default"] }`

### `DELETE /v1/profiles/:slug`

Delete a profile and all its memories. The `default` profile is protected (returns 400).

**Response:** `{ "deleted": 15, "profile": "alice" }`

### `DELETE /v1/graph/triple/:id`

Delete a single semantic triple. **Query params:** `profile` / `profileId`

**Response:** `{ "deleted": 1 }`

### `GET /v1/graph/triples`

**Query params:** `entity` (required), `direction` (`incoming`|`outgoing`|`in`|`out`), `maxResults` (default 100), `predicate`, `profile`/`profileId`

**Response:**
```json
{
  "entity": "User",
  "triples": [
    { "id": "uuid", "subject": "User", "predicate": "works at", "object": "Anthropic", ... }
  ],
  "count": 1
}
```

### `GET /v1/graph/neighbors`

**Query params:** `entity` (required), `profile`/`profileId`

**Response:** `{ "entity": "User", "neighbors": ["Anthropic", "Berlin"], "count": 2 }`

### `GET /v1/graph/paths`

BFS path-finding between two entities.

**Query params:** `from` (required), `to` (required), `maxDepth` (default 3), `profile`/`profileId`

**Response:**
```json
{
  "from": "User", "to": "AI Safety",
  "paths": [{ "path": [triple1, triple2], "depth": 2 }],
  "count": 1
}
```

### `GET /v1/graph/visualization`

Graph data for UI rendering. BFS expansion from optional center entity.

**Query params:** `entity` (optional center), `maxDepth` (default 2), `maxNodes` (default 50), `profile`/`profileId`, `includeHistory` (`true`|`1`)

**Response:**
```json
{
  "center": "User",
  "nodes": [{ "id": "User", "label": "User" }, { "id": "Anthropic", "label": "Anthropic" }],
  "edges": [{ "source": "User", "target": "Anthropic", "predicate": "works at" }],
  "includeHistory": false,
  "profile": "default"
}
```

---

## 7. Development Guidelines

### Design Decisions

1. **Brute-force cosine search** — No ANN index. Scans up to `SECTOR_SCAN_LIMIT=200` rows per sector. Sufficient for current scale but will need an index (e.g., HNSW via sqlite-vss) for larger datasets.

2. **Same embedding model for all sectors** — The `_sector` param in `embed()` is accepted but unused. All sectors use the same model. This is intentional simplification; per-sector models could be added later.

3. **Fixed control signal** — `CONTROL_SIGNAL = 0.3` is hardcoded. Intended to eventually be task-adaptive.

4. **Decay = 1** — Time-based decay is not yet implemented. The `decay` field in `QueryResult` is always `1`. The infrastructure is there (timestamps are tracked) but the formula hasn't been wired.

5. **SQLite for storage** — Single-file database, no server needed. Suitable for single-node deployment. The `better-sqlite3` driver is synchronous.

6. **ESM modules** — Package uses `"type": "module"` throughout.

### Known Limitations

- **No tests** — There are no unit or integration tests. When adding features, consider adding tests.
- **No ANN index** — Cosine similarity is computed brute-force over up to 200 rows per sector.
- **Decay not implemented** — `decay` is always 1 in query results.
- **`reasoning` and `feedback` fields unused** — Accepted in `/v1/ingest` but not stored or processed.
- **`strict: false`** in tsconfig — TypeScript strict mode is off.
- **No authentication** — All endpoints are open. CORS is the only access control.
- **Sector weight is always 1.0** — The `sectorWeight` param in PBWM scoring is always passed as 1.0; per-sector weighting is not implemented.
- **Provider note in README is outdated** — The README says "Only Gemini provider is wired" but OpenAI is fully implemented in the provider system.

### Common Patterns

**Adding a new endpoint:**
1. Add route in `server.ts`
2. Resolve profile: `const profile = normalizeProfileSlug(req.body.profile || req.body.profileId || req.query.profile || req.query.profileId)`
3. Call store methods for data access
4. Wrap in try/catch, return JSON errors with appropriate status codes

**Adding a new memory sector:**
1. Add to `SectorName` union in `types.ts`
2. Add to `SECTORS` array in `sqlite-store.ts`
3. Add to `IngestComponents` interface in `types.ts`
4. Handle in `ingest()` method in `sqlite-store.ts`
5. Handle in `search()` candidate loading in `sqlite-store.ts`
6. Update extraction prompt in `providers/prompt.ts`

**Adding a new provider:**
1. Add config to `PROVIDERS` map in `providers/registry.ts`
2. Add request/response mapping in `embed.ts` and `extract.ts`

### Where to Add New Features

| Feature | Where |
|---------|-------|
| New API endpoint | `server.ts` |
| New storage logic | `sqlite-store.ts` |
| Schema changes | `sqlite-store.ts` `prepareSchema()` or migration block |
| New memory type | `types.ts` + `sqlite-store.ts` + `providers/prompt.ts` |
| Scoring changes | `scoring.ts` |
| Graph algorithms | `semantic-graph.ts` |
| New provider | `providers/registry.ts` + `embed.ts` + `extract.ts` |
| Working memory logic | `wm.ts` |
| Consolidation logic | `consolidation.ts` |
| Document ingestion | `documents.ts` (chunking, orchestration) |

---

## 8. Testing & Verification

### Local Testing

```bash
# 1. Start the memory service
npm start -w memory

# 2. Health check
curl http://localhost:4005/health

# 3. Ingest a memory
curl -X POST http://localhost:4005/v1/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      {"role": "user", "content": "I work at Anthropic as a senior engineer. I love working on AI safety."}
    ]
  }'

# 4. Search memories
curl -X POST http://localhost:4005/v1/search \
  -H 'Content-Type: application/json' \
  -d '{"query": "Where does the user work?"}'

# 5. View summary
curl http://localhost:4005/v1/summary

# 6. List profiles
curl http://localhost:4005/v1/profiles

# 7. Query semantic graph
curl "http://localhost:4005/v1/graph/triples?entity=User"

# 8. Get graph visualization
curl "http://localhost:4005/v1/graph/visualization?entity=User&maxDepth=2"

# 9. Find paths between entities
curl "http://localhost:4005/v1/graph/paths?from=User&to=Anthropic"

# 10. Update a memory
curl -X PUT http://localhost:4005/v1/memory/MEMORY_ID \
  -H 'Content-Type: application/json' \
  -d '{"content": "Updated content"}'

# 11. Delete a memory
curl -X DELETE "http://localhost:4005/v1/memory/MEMORY_ID"

# 12. Delete all memories for a profile
curl -X DELETE "http://localhost:4005/v1/memory?profile=default"

# 13. Ingest markdown documents from a directory
curl -X POST http://localhost:4005/v1/ingest/documents \
  -H 'Content-Type: application/json' \
  -d '{"path": "/path/to/markdown/folder", "profile": "docs"}'

# 14. Re-ingest same folder (should show skipped > 0, stored ≈ 0)
curl -X POST http://localhost:4005/v1/ingest/documents \
  -H 'Content-Type: application/json' \
  -d '{"path": "/path/to/markdown/folder", "profile": "docs"}'

# 15. Check source attribution
sqlite3 memory/memory.db "SELECT source, content FROM memory WHERE source IS NOT NULL LIMIT 5;"
```

### Verify Embeddings Are Working

If embeddings fail, the `/v1/ingest` endpoint will return a 500 error. Check:

1. `GOOGLE_API_KEY` is set (or `OPENAI_API_KEY` if using OpenAI provider)
2. The embedding model is accessible (try a direct API call)
3. Check server console for fetch errors from `embed.ts`

### Database Inspection

The SQLite database is at `MEMORY_DB_PATH` (default `./memory.db`). You can inspect it directly:

```bash
# Open with sqlite3
sqlite3 memory/memory.db

# Count memories per sector
SELECT sector, COUNT(*) FROM memory GROUP BY sector;

# View semantic triples
SELECT subject, predicate, object, valid_to IS NULL as active FROM semantic_memory;

# Check procedural memories
SELECT trigger, goal, steps FROM procedural_memory;

# View profiles
SELECT * FROM profiles;
```

---

## 9. Integration Notes

### Position in ekai-gateway

The memory service is one of three workspaces in the ekai-gateway monorepo:

```
ekai-gateway/
├── gateway/          # Main API gateway (proxy/passthrough for LLM providers)
├── ui/dashboard/     # Next.js dashboard UI
└── memory/           # This service (standalone, port 4005)
```

Registered in root `package.json`:
```json
"workspaces": ["gateway", "ui", "memory"]
```

Started together with:
```json
"dev:all": "concurrently \"npm run dev --workspace=gateway\" \"npm run dev --workspace=ui/dashboard\" \"npm run start --workspace=memory\""
```

### Two Memory Systems

The ekai-gateway has **two independent memory systems**:

1. **Gateway file memory** (`gateway/src/infrastructure/memory/`) — Simple FIFO conversation log stored as JSON in a flat file (`MEMORY.md`). Used automatically by all gateway passthrough handlers. No embeddings, no sectors. Controlled by `MEMORY_BACKEND` env var (`file` or `none`), `MEMORY_MAX_ITEMS` (default 20). Helper functions `injectMemoryContext()` and `persistMemory()` are called in `chat-completions-passthrough.ts`, `messages-passthrough.ts`, and `openai-responses-passthrough.ts`.

2. **Memory service** (this codebase) — Neuroscience-inspired sectorized memory with embeddings, PBWM gating, and knowledge graph. Runs standalone on port 4005. The dashboard UI talks to it directly via `NEXT_PUBLIC_MEMORY_BASE_URL`.

**These two systems are not yet wired together.** The gateway passthrough handlers do not call the memory service's API. The memory service is designed to eventually replace or augment the file-based system, but that integration has not been built.

### Dashboard Integration

The dashboard (`ui/dashboard/src/lib/api.ts`) connects to the memory service at `NEXT_PUBLIC_MEMORY_BASE_URL` (default `http://localhost:4005`). It exposes methods for:
- `getMemorySummary`, `deleteMemory`, `deleteAllMemories`, `updateMemory`
- `getGraphVisualization`, `getGraphTriples`
- `getProfiles`, `deleteProfile`, `deleteGraphTriple`
