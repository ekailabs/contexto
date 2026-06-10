# Contexto × Hermes Local Backend — Design

**Status:** approved
**Date:** 2026-05-23
**Extends:** [`2026-05-22-contexto-hermes-plugin-design.md`](./2026-05-22-contexto-hermes-plugin-design.md)
**Implements:** `LocalBackend` for `contexto-hermes`, mirroring the TS `LocalBackend` in `@ekai/contexto`'s `local/` module

---

## 1. Goal

Make Contexto's local mode available to Hermes the same way it's available to OpenClaw: no Contexto-hosted API calls; embeddings and summarization call the user's chosen provider (OpenAI or OpenRouter); state lives on disk as a single JSON file. Behavior matches `@ekai/contexto`'s `LocalBackend` (`packages/contexto/src/local/backend.ts`) on the user-observable contract.

The v1 plugin spec ([§2 Out of scope](./2026-05-22-contexto-hermes-plugin-design.md)) deferred this; this spec fills the gap.

## 2. Scope

### In scope

- New `LocalBackend` class inside the existing `contexto-hermes` Python package. Sync. Same duck-typed contract as `RemoteBackend` (`ingest`, `search`, never-raises).
- Selectable via `CONTEXTO_BACKEND=local`. Default stays `remote`.
- Pure-Python. **No Node.js dependency.** `numpy` + `scipy` + `httpx` only.
- AGNES hierarchical clustering via `scipy.cluster.hierarchy.linkage(method='average', metric='cosine')`. Defaults match TS `DEFAULT_CONFIG`: `similarity_threshold=0.65`, `max_depth=4`, `max_children=10`, `rebuild_interval=50`.
- Beam-search retrieval over the cluster tree (`beam_width=3`).
- Per-ingest LLM summarization (parity with TS `summarizeEpisode`), opt-out via env var.
- On-disk JSON state, default `$HERMES_HOME/data/contexto/mindmap.json` (Hermes home dir; `~/.hermes` locally, `/opt/data` in container).
- Local episode-text extractor that reads Hermes' flat `data.messages` payload and produces the same `Q:` / `A:` / `T:`-prefixed text TS produces from its `data.userMessage` / `assistantMessages` / `toolMessages` shape.

### Out of scope (v1 of the local backend)

- Byte-for-byte interop with the TS `mindmap.json` on-disk format.
- Multi-writer concurrency.
- Approximate-nearest-neighbor indexes (HNSW, IVF). AGNES is fine to ~10k items.
- Local embedding models (sentence-transformers, BGE, …).
- Gemini provider. TS supports three; Python v1 supports `openai` + `openrouter`.
- LLM-rewritten cluster labels. Cluster labels use TS's lightweight keyword extraction.

## 3. Repo layout

Additive to the layout from [§3 of the v1 spec](./2026-05-22-contexto-hermes-plugin-design.md):

```
contexto/packages/contexto-py/
├── src/contexto_hermes/
│   ├── __init__.py          # MODIFIED — backend-aware register()
│   ├── engine.py            # MODIFIED — backend selector + from_env_local()
│   ├── types.py             # MODIFIED — ContextoConfig.local_mode_defaults();
│   │                        #            SearchResult.paths: list[dict] → list[list[str]]
│   ├── plugin.yaml          # MODIFIED — adds CONTEXTO_LOCAL_* env vars
│   └── local/               # NEW
│       ├── __init__.py
│       ├── backend.py       # LocalBackend orchestrator
│       ├── extractor.py     # episode text from data.messages → Q:/A:/T:
│       ├── store.py         # JSON load/save + corrupt-file quarantine
│       ├── labeler.py       # cluster labels (port of TS generateLabel)
│       ├── clustering.py    # scipy AGNES + incremental insert + rebuild policy
│       ├── retrieval.py     # beam search with similarity_threshold pruning
│       ├── embedder.py      # httpx → /embeddings, provider-specific defaults
│       ├── summarizer.py    # httpx → /chat/completions, provider-specific defaults
│       └── mindmap_types.py # dataclasses
├── tests/local/             # NEW
├── tests/fixtures/local-backend/  # NEW
└── pyproject.toml           # MODIFIED — adds numpy, scipy
```

`httpx` is already a `RemoteBackend` dependency; only `numpy` and `scipy` are new.

## 4. Backend selection & registration

The v1 plugin only registers when `CONTEXTO_API_KEY` is set. The local backend doesn't need that key — it needs a provider key instead.

| `CONTEXTO_BACKEND` | Required env vars |
|---|---|
| `remote` (default) | `CONTEXTO_API_KEY` |
| `local` | one of `OPENAI_API_KEY` or `OPENROUTER_API_KEY` |

`CONTEXTO_API_KEY` is not required in local mode; if present, it is ignored.

Registration behavior:

1. Read `CONTEXTO_BACKEND`. Invalid values are coerced to `remote` with a WARNING log.
2. Attempt construction via the appropriate path: `ContextoEngine.from_env()` for remote, `ContextoEngine.from_env_local()` for local. Construction-time exceptions are caught and logged at ERROR; the plugin does not register.
3. If the constructor returns `None`, log a backend-appropriate error pointing at the prior `from_env` log (which already explained the specific reason) and do not register.
4. Otherwise register the engine on the plugin context.

`ContextoEngine.from_env_local()` returns `None` when local credentials/config are unusable; otherwise it builds a `LocalBackendConfig` via `from_env` (rules in §7), constructs a `ContextoConfig` via `local_mode_defaults()`, and returns a `ContextoEngine` with the `LocalBackend` injected through the existing optional `backend=` constructor arg.

`ContextoConfig.local_mode_defaults()` returns a `ContextoConfig` with `api_key=""` (unused in local mode) and the existing `CONTEXTO_*` defaults — keeps `compress()`-time formatting code unchanged.

## 5. Architecture

Ten modules under `local/`. Each has one job. All public-boundary errors are caught at `backend.py` and converted to `False` / `None`; internals raise normally.

### `backend.py` — `LocalBackend`

Same duck-typed contract as `RemoteBackend`. Mirrors TS `LocalBackend` in `packages/contexto/src/local/backend.ts`.

- `__init__(config: LocalBackendConfig, *, embedder=None, summarizer=None, store=None, embed_transport=None, llm_transport=None)` — stores config; lazy `Store.load()` on first ingest/search. Uses the module-level logger (`plugins.context_engine.contexto`) — matches the Python-idiomatic pattern used by `RemoteBackend`, not the TS `logger: Logger` arg. The keyword-only kwargs are test seams that let unit tests inject fakes or `httpx.MockTransport`; production code constructs with just the config.
- `ingest(payloads: list[WebhookPayload]) -> bool` — embed + (optionally) summarize + insert. Returns success. Never raises.
- `search(query: str, max_results: int, filter: dict | None = None, min_score: float | None = None) -> SearchResult | None` — embed query, beam-search tree, score, return top-K wrapped as `{"item": ConversationItem-dict, "score": float}` per TS `ScoredQueryResult`. Returns `None` only on failure; an empty result set (empty store, nothing survives filtering) is an empty `SearchResult` — matching `RemoteBackend`, so the tool layer can distinguish "no matches" from "backend down". Never raises.

### `extractor.py`

Pure function `extract_episode_text(payload) -> str`. Hermes' `build_episode_payload` writes `data: {"messages": [...]}` — a flat list of role-tagged messages. TS expects `data.userMessage` / `assistantMessages` / `toolMessages`, a shape OpenClaw produces but Hermes does not.

The extractor reads the flat shape and produces the same Q:/A:/T: text:

- `event.type != 'episode'` or `event.action != 'combined'` → `""`
- For each message in `data.messages`:
  - `role == 'user'`: `normalize_message_text` → `strip_metadata_envelope` → prefix `Q:`
  - `role == 'assistant'`: extract text → prefix `A:` (skip empty)
  - `role == 'tool'`: extract text → prefix `T:` (skip empty)
  - Other roles: ignored
- Join with `\n`

### `store.py`

JSON load/save.

- **Save:** `mkdir(parents=True, exist_ok=True)` on the parent directory, then atomic write via `<path>.tmp` + `os.replace`.
- **Load:** on parse failure or schema mismatch, rename the file aside to `<path>.corrupted-<unix-millis>`, log ERROR, return a fresh empty `StoreState`. Subsequent saves write to the original path; the user can inspect or restore the renamed file. No silent overwrite.
- Single-writer assumption (no file lock in v1).

### `labeler.py`

Port of TS `generateLabel` in `packages/mindmap/src/labeler.ts`. Same STOP_WORDS set, same three-branch behavior:

- 0 items → `"Empty"`
- 1 item → first 4 keywords of `content`; fallback `content[:30]`
- n items → keywords of the item closest to the centroid; fallback to top 3 most-frequent keywords across all items; final fallback `"Cluster"`

Labels are user-visible only via the `paths` field of `SearchResult`.

### `clustering.py`

All mindmap tunables live under `LocalBackendConfig.mindmap` (a nested `MindmapConfig` dataclass). Clustering accesses them as `self._config.mindmap.<field>`.

**Rebuild** handles three cases (scipy.linkage raises with n < 2):

- 0 items → root `ClusterNode("root", "Knowledge", [], children=[], items=[], depth=0, item_count=0)`. No scipy call.
- 1 item → root with one leaf child.
- 2+ items → `scipy.cluster.hierarchy.linkage(embeddings, method='average', metric='cosine')`, convert the linkage matrix to a `ClusterNode` tree, cut at `similarity_threshold` (distance ≤ `1 - threshold`) and cap at `max_depth`.

**Incremental insert:** descend from root choosing the child with highest cosine similarity to the item's embedding; if `sim >= similarity_threshold` and `child.depth < max_depth`, descend into it; otherwise create a new child cluster; update centroids on the visited path.

**Rebuild policy.** Rebuild when `new_total < 100` OR `inserts_since_rebuild + new_items_count >= rebuild_interval`. Otherwise insert incrementally. Matches TS `addToMindmap`.

After every add, `state.stats` is updated: `total_items`, `total_clusters`, `inserts_since_rebuild` (reset to 0 on rebuild).

### `retrieval.py`

Beam search over the cluster tree (port of TS `queryMindmapMultiBranch`):

1. Score root's children by cosine sim to the query; keep top `beam_width` above `similarity_threshold`.
2. Expand each beam entry. Entries with no children passing threshold become terminal.
3. Collect items from all terminals; dedup by `id`.
4. Apply `filter` (exact-match on `metadata[key]`); score by cosine sim to query.
5. Sort descending; apply `min_score`; slice to `max_results`.

Returns `ScoredQueryResult(items, paths, …)`. `paths` is `list[list[str]]` of cluster *labels* (not IDs), matching TS. `items` is `list[{"item": dict, "score": float}]` so callers can rank/threshold downstream; the engine's `_entry_id` and `format_search_results` accept this wrapped shape (and fall back to bare items).

### `embedder.py` and `summarizer.py`

Per-call `with httpx.Client(...) as c:`. Provider-specific defaults:

| Provider | `embed_model` | `llm_model` |
|---|---|---|
| `openai` | `text-embedding-3-small` | `gpt-4o-mini` |
| `openrouter` | `openai/text-embedding-3-small` | `openai/gpt-4o-mini` |

`summarizer.summarize` mirrors TS `summarizeEpisode` (`packages/contexto/src/local/summarizer.ts`): same system prompt, `temperature=0.2`, `response_format={"type": "json_object"}`. On HTTP error, parse failure, or unknown provider, returns a fallback `EpisodeSummary` (matches TS `buildFallback`).

When `CONTEXTO_LOCAL_SUMMARIZE=false`, `backend.py` calls `summarizer.build_synthetic_summary(extracted_text)` instead, which produces an `EpisodeSummary` from raw text without any LLM call. The distinct `key_findings` marker (`"Episode processed (summarization disabled)"`) distinguishes it from the LLM-failure fallback. Downstream metadata/content construction stays branch-free.

### `mindmap_types.py`

Plain `@dataclass` types. Module named `mindmap_types.py` to avoid colliding with `contexto_hermes.types`. The on-disk schema in §8 is the source of truth for field semantics; the dataclasses mirror it.

- **`MindmapConfig`** — `similarity_threshold=0.65`, `max_depth=4`, `max_children=10`, `rebuild_interval=50`. Mirrors TS `DEFAULT_CONFIG`.
- **`LocalBackendConfig`** — `storage_path`, `provider` (`openai` | `openrouter`), `api_key`, `embed_base_url`, `llm_base_url`, `embed_model: str | None = None` (None → provider default, resolved by `resolved_embed_model()`), `llm_model: str | None = None` (None → provider default, resolved by `resolved_llm_model()`), `summarize=True`, nested `mindmap: MindmapConfig`, `beam_width=3`, `embed_timeout=30.0`, `llm_timeout=60.0`. Classmethod `from_env()` returns `None` on unusable config; rules in §7.
- **`EvidenceRef`** — `type` (`episode_ref` | `tool_ref` | `file_ref` | `trace_ref`), `value`.
- **`EpisodeSummary`** — `summary`, `key_findings: list[str]`, `status` (`complete` | `partial` | `blocked`), `confidence: float`, `evidence_refs: list[EvidenceRef]`, `open_questions: list[str] | None`.
- **`ConversationItem`** — `id`, `role`, `content`, `embedding: list[float]`, `timestamp: str | None`, `metadata: dict[str, Any]`.
- **`ClusterNode`** — `id`, `label`, `centroid: list[float]`, `children: list[ClusterNode]`, `items: list[ConversationItem]`, `depth`, `item_count`.
- **`StoreStats`** — `total_items=0`, `total_clusters=0`, `inserts_since_rebuild=0`.
- **`StoreState`** — `version=1`, `config_snapshot: dict[str, Any]`, `root: ClusterNode | None`, `stats: StoreStats`.

## 6. Item metadata

When `LocalBackend.ingest` builds a `ConversationItem`, the `metadata` object carries these keys (matches TS apart from `episode`):

| Key | Value |
|---|---|
| `source` | always the literal `"summary"` |
| `status` | from `EpisodeSummary.status` (`complete` \| `partial` \| `blocked`) |
| `confidence` | from `EpisodeSummary.confidence` (float, 0–1) |
| `evidence_refs` | from `EpisodeSummary.evidence_refs` — list of `{type, value}` objects |
| `open_questions` | from `EpisodeSummary.open_questions` (list of strings or null) |
| `trace_ref` | fresh UUID4 per item |
| `sessionKey` | from the payload's `sessionKey` |
| `episode` | `{"extracted_text": <text>}` — see below |

`content` is `summary.summary` followed by a `Key findings:` section (newline-separated bullets) when `key_findings` is non-empty.

The `episode` sub-object diverges from TS (which stores three pre-split message lists; Hermes' payload doesn't have them pre-split). `format_search_results` reads `status`, `confidence`, `evidence_refs`, `trace_ref` — present and unchanged.

## 7. Configuration

All env-var driven. Additive to the v1 plugin's `CONTEXTO_*` vars.

| Env var | Default | Purpose |
|---|---|---|
| `CONTEXTO_BACKEND` | `remote` | `remote` or `local` |
| `CONTEXTO_LOCAL_STORAGE_PATH` | `$HERMES_HOME/data/contexto/mindmap.json` (fallback `~/.hermes/data/contexto/mindmap.json`) | JSON store path |
| `CONTEXTO_LOCAL_PROVIDER` | `openrouter` if `OPENROUTER_API_KEY` set, else `openai` | Embeddings + LLM provider |
| `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | — | Standard names; matches the selected provider |
| `CONTEXTO_LOCAL_EMBED_MODEL` | provider-specific (see §5) | Embeddings model override |
| `CONTEXTO_LOCAL_LLM_MODEL` | provider-specific (see §5) | Summarization model override |
| `CONTEXTO_LOCAL_SUMMARIZE` | `true` | Opt out of per-ingest LLM summarization |
| `CONTEXTO_LOCAL_SIMILARITY_THRESHOLD` | `0.65` | Cosine threshold for cluster cuts and beam pruning |
| `CONTEXTO_LOCAL_MAX_DEPTH` | `4` | Maximum tree depth |
| `CONTEXTO_LOCAL_MAX_CHILDREN` | `10` | Informational (matches TS; not enforced as a hard cap) |
| `CONTEXTO_LOCAL_REBUILD_INTERVAL` | `50` | Items between full rebuilds |
| `CONTEXTO_LOCAL_BEAM_WIDTH` | `3` | Retrieval beam width |
| `CONTEXTO_LOCAL_EMBED_TIMEOUT` | `30` | Embeddings request timeout (seconds) |
| `CONTEXTO_LOCAL_LLM_TIMEOUT` | `60` | LLM request timeout (seconds) |

### Provider / key resolution

Explicit `CONTEXTO_LOCAL_PROVIDER` wins and requires its matching key. Explicit never silently falls back to the other provider — failing loudly beats quietly billing the wrong account.

| `CONTEXTO_LOCAL_PROVIDER` | Outcome |
|---|---|
| (unset) | Prefer `openrouter` if `OPENROUTER_API_KEY` is set; else `openai` if `OPENAI_API_KEY`; else `from_env` returns `None` |
| `openai` | Use `OPENAI_API_KEY`. Missing key → `from_env` returns `None` (ERROR log) |
| `openrouter` | Use `OPENROUTER_API_KEY`. Missing key → `from_env` returns `None` (ERROR log) |
| any other value | `from_env` returns `None` (ERROR log) |

`CONTEXTO_LOCAL_STORAGE_PATH` follows Hermes' data-dir convention: it resolves `$HERMES_HOME` (the Hermes home dir env var; defaults to `~/.hermes`, set to `/opt/data` in the Hermes Docker image) and appends `data/contexto/mindmap.json`. In a Docker container this lands at `/opt/data/data/contexto/mindmap.json`; locally at `~/.hermes/data/contexto/mindmap.json`.

## 8. Storage format

```json
{
  "version": 1,
  "config_snapshot": {
    "embed_model": "text-embedding-3-small",
    "llm_model": "gpt-4o-mini",
    "provider": "openai",
    "similarity_threshold": 0.65,
    "max_depth": 4,
    "max_children": 10,
    "rebuild_interval": 50,
    "beam_width": 3
  },
  "stats": { "total_items": 42, "total_clusters": 7, "inserts_since_rebuild": 3 },
  "root": {
    "id": "root",
    "label": "Knowledge",
    "centroid": [...],
    "children": [
      {
        "id": "cluster-1",
        "label": "deployment errors",
        "centroid": [...],
        "children": [],
        "items": [
          {
            "id": "01H...",
            "role": "assistant",
            "content": "...",
            "embedding": [...],
            "timestamp": "2026-05-23T12:00:00.000Z",
            "metadata": { "source": "summary", "status": "complete", "...": "..." }
          }
        ],
        "depth": 1,
        "item_count": 5
      }
    ],
    "items": [],
    "depth": 0,
    "item_count": 42
  }
}
```

- Atomic writes only.
- Not byte-compatible with TS `MindmapState`. Python uses `snake_case` and a simpler schema. This is intentional — see §2.
- `version: 1` declared up front. Future format bumps gain a migration path; v1 readers reject unknown versions with an ERROR log + quarantine.

## 9. Data flow

### `ingest`

1. Filter payloads to episode/combined events only; non-episode events are ignored.
2. For each episode, in order:
   - Extract Q:/A:/T: text from the episode (see §5 extractor).
   - Produce an `EpisodeSummary` — via the configured LLM when summarization is enabled, or via the synthetic-summary helper when `CONTEXTO_LOCAL_SUMMARIZE=false`.
   - Embed the item's content (summary + key findings) via the configured provider.
   - Build a `ConversationItem` with metadata per §6.
3. Hand the new items to the clusterer, which decides between full rebuild and incremental insert per §5 and updates `state.stats`.
4. Save the resulting state to disk.

### `search`

1. Embed the query.
2. Run beam search over the cluster tree, collecting terminal nodes and their items.
3. Apply the metadata filter (exact-match on each provided key), score remaining items by cosine similarity, apply `min_score`, slice to `max_results`.
4. Return a `SearchResult` with `items` and `paths` (possibly empty).

`search` returns `None` only on failure (embed error, unexpected exception). An empty store (no cluster tree yet) or a query where no items survive filtering returns an empty `SearchResult`. The empty-store guard short-circuits before the query embedding is requested.

## 10. Error contract

`ingest` and `search` **never raise.** Mirrors `RemoteBackend`.

| Failure mode | Return | Logged at |
|---|---|---|
| Embedder HTTP/network error | `ingest`: `False`. `search`: `None`. | ERROR |
| Summarizer HTTP/parse error | `ingest`: continues with fallback summary; returns `True` if rest succeeds. | WARNING |
| `store.save()` I/O error | `ingest`: `False`. | ERROR |
| `store.load()` corrupt file | file quarantined; fresh empty state returned. | ERROR |
| `scipy.linkage` failure (NaN, etc.) | `ingest`: `False`. | ERROR |
| Local construction failure | `from_env_local()` returns `None`; `register()` skips registration. | ERROR |
| Empty store / no results on search | `search`: empty `SearchResult` (not a failure). | (not logged) |

No `ApiError` / `on_error` / `on_success` callbacks in v1 of the local backend.

## 11. Testing

Located in `contexto-py/tests/local/`.

- **Per-module unit tests.** Extractor (Q:/A:/T: prefixes, envelope stripping); labeler (STOP_WORDS, 0/1/n-item branches); embedder + summarizer (`httpx.MockTransport`, provider model selection, fallback paths, `build_synthetic_summary` shape); clustering (rebuild policy, scipy golden outputs, centroid invariants); retrieval (synthetic trees, beam pruning, `paths` are labels not IDs); store (round-trip, atomic-write, corrupt-file quarantine, parent-dir creation).
- **Integration round-trip.** `tests/local/test_round_trip.py` instantiates `LocalBackend` with fake embedder/summarizer, ingests fixture episodes (40 → confirms `new_total < 100` rebuild; +20 → confirms threshold reuse), searches, asserts top-K item IDs, reinstantiates against the same path and confirms stats reload. Empty-store guard test: construct against a fresh path, patch `retrieval.beam_search` to raise, call `search` — passes iff the guard fires and `search` returns an empty `SearchResult` without invoking retrieval.
- **Provider/key matrix.** One parametrized test per row of §7's table, covering explicit/implicit provider selection and explicit/key mismatch.
- **Registration.** `local` with no provider key (error + no registration); `local` with one of the two keys (constructs `LocalBackend`); `remote` with no `CONTEXTO_API_KEY` (existing behavior preserved); invalid `CONTEXTO_BACKEND` value (warns + falls back to remote).
- **Behavioral fixtures.** `tests/fixtures/local-backend/` holds small JSON files of `(seed_items, queries, expected_top_k_ids)` for cheap regression coverage.
- **Error-contract tests.** For each row in §10, assert the public boundary returns the documented value and never raises.

## 12. Risks & open items

1. **Single-writer assumption.** Concurrent ingests against the same path race. Atomic replace prevents corruption; last-writer-wins drops data. Add `fcntl.flock` if multi-process use appears.
2. **AGNES at scale.** Full rebuild is O(n² log n) time and O(n²) memory. Past ~10–20k items, rebuilds become painful. HNSW (`hnswlib`) is the path forward, not a fundamental rewrite.
3. **Embedding/LLM cost on every ingest.** With `SUMMARIZE=true`, every episode triggers an embed call plus an LLM call. Opt-out via env var.
4. **Provider API drift.** Both TS and Python implementations call OpenAI/OpenRouter directly. API changes need to be applied in both languages; the small `httpx` surface bounds the blast radius.
5. **TS↔Python behavioral drift.** No shared algorithm code. scipy's AGNES may differ subtly from TS's `ml-hclust` in tie-breaking and floating-point order. Behavioral fixtures asserting top-K item IDs (not exact scores) are the practical guard.
6. **`max_children` not enforced.** Matches TS — the value exists in defaults but isn't used as a hard cap in the build/insert paths.
7. **Storage path convention.** Default resolved from `$HERMES_HOME` (Hermes' standard home-dir env var; defaults `~/.hermes`, `/opt/data` in container). Works without further configuration in both local and Docker contexts.

## 13. Versioning & compatibility

- `contexto-hermes` semver stays independent of `@ekai/contexto`. Adding `LocalBackend` is a MINOR bump (proposed `0.2.0`).
- On-disk JSON `version: 1`. Future format changes bump this and gain a migration path.
- `numpy` and `scipy` added to runtime deps. If wheel-size becomes a complaint, move them to an optional extra (`pip install contexto-hermes[local]`) in a future MINOR.
- `__compatible_contexto_api__` is unaffected — the local backend doesn't call `api.getcontexto.com`.
