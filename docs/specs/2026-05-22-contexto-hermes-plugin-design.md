# Contexto × Hermes Context Engine Plugin — Design

**Status:** approved
**Date:** 2026-05-22
**Implements:** Contexto as a first-class context engine plugin for hermes-agent

---

## 1. Goal

Make Contexto available to Hermes the same way it's available to OpenClaw: install a plugin, set one config key, and Contexto becomes the active context engine.

Behavior matches `@ekai/contexto`'s remote mode in OpenClaw, mapped onto Hermes' `ContextEngine` ABC contract.

## 2. Scope

### In scope (v1)

- Python package shipped from the `contexto` repo. Remote backend only — `POST /v1/webhooks/events` and `POST /v1/mindmap/search` against `https://api.getcontexto.com`.
- Full context engine in the `plugins/context_engine/<name>/` slot. Standard ABC only; no hermes-agent core changes.
- Compaction inside `compress()`: ingest the drop slice, retrieve, evict from context window.
- `contexto_search` engine tool via the ABC's `get_tool_schemas()` / `handle_tool_call()` — lets the agent pull prior context between compactions.
- Auth via `CONTEXTO_API_KEY` env var; all tunables via `CONTEXTO_*` env vars. No Hermes config block.
- `CONTEXTO_ENABLED=false` disables retrieval injection but keeps ingest + trim (mirrors TS `contextEnabled: false`).

### Out of scope (v1)

- Local backend (TS `local` mode).
- Per-turn retrieval injection — Hermes' ABC has no before-LLM-call hook ([official doc](https://hermes-agent.nousresearch.com/docs/developer-guide/context-engine-plugin) §9). `contexto_search` is the substitute.
- TS `sliding-window` token-budget eviction. v1 uses fixed `protect_first_n` / `protect_last_n`.
- Sub-agent context delegation, scoped boundaries, external doc ingestion, `ContextCompressor` state migration.
- Async client (ABC `compress()` is sync).

## 3. Repo layout

New Python package sibling to the existing TS package inside the `contexto` monorepo:

```
contexto/
├── packages/
│   ├── contexto/              # existing TS — @ekai/contexto
│   └── contexto-py/           # NEW Python — PyPI package `contexto-hermes`
│       ├── pyproject.toml
│       ├── README.md
│       ├── src/contexto_hermes/
│       │   ├── __init__.py    # plugin entry; exposes ContextoEngine
│       │   ├── engine.py      # ContextoEngine(ContextEngine)
│       │   ├── client.py      # RemoteBackend (httpx.Client)
│       │   ├── helpers.py     # strip_metadata_envelope, format_search_results, build_episode_payload, normalize_message_text
│       │   ├── tools.py       # contexto_search tool schema + handler
│       │   ├── types.py       # dataclasses: ContextoConfig, WebhookPayload, SearchResult
│       │   └── install.py     # python -m contexto_hermes.install entry point (see §4)
│       ├── tests/
│       └── plugin.yaml        # Hermes plugin manifest
```

`pnpm-workspace.yaml` globs `packages/**` but only picks up packages with `package.json`. The Python sibling is invisible to pnpm. Both packages share the repo, README links, CHANGELOG, and the `ContextoBackend` interface contract — but ship as independent artifacts on independent semver.

**PyPI package name:** `contexto-hermes`. (Plain `contexto` may collide on PyPI; `contexto-hermes` is unambiguous and pairs cleanly with the OpenClaw-targeted `@ekai/contexto`.)

**Python version:** 3.10+. The spec uses PEP 604 union syntax (`str | None`), PEP 585 generics (`dict[str, Any]`, `list[...]`), and dataclass features that require 3.10 or newer. Pinned in `pyproject.toml` via `requires-python = ">=3.10"`.

**Versioning policy.** `contexto-hermes` and `@ekai/contexto` ship on independent semver. Python releases pin the compatible `api.getcontexto.com` schema version (effectively the TS plugin's API contract) in the `CHANGELOG.md` and in a module-level `__compatible_contexto_api__` string. Bumping either package never forces a bump in the other.

## 4. Installation

Hermes' context-engine loader only scans `plugins/context_engine/<name>/` inside the installed hermes-agent; `$HERMES_HOME/plugins/` is NOT scanned. The plugin must land in the bundled tree.

Recommended path:

```bash
pip install contexto-hermes
python -m contexto_hermes.install      # detects Hermes path, symlinks (or copies)
export CONTEXTO_API_KEY=ckai_xxx
# then add `context: { engine: contexto }` to ~/.hermes/config.yaml
```

The `install` command MUST ship in v1 — bare shell snippets break on read-only site-packages, editable installs, and package-manager upgrades that wipe the bundled tree. The command verifies write permissions, prefers symlink, falls back to copy, and emits a clear error if the install path is read-only.

(Widening Hermes' discovery to `$HERMES_HOME/plugins/context_engine/` is a future upstream PR — not v1.)

## 5. Architecture

Six modules, each with one job.

### `__init__.py` — plugin entry

```python
import logging
from .engine import ContextoEngine

logger = logging.getLogger("plugins.context_engine.contexto")

def register(ctx):
    engine = ContextoEngine.from_env()
    if engine is None:
        logger.error(
            "Contexto plugin not registered: CONTEXTO_API_KEY is not set. "
            "Hermes will fall back to the default 'compressor' engine. "
            "Get a key at https://getcontexto.com and `export CONTEXTO_API_KEY=...`."
        )
        return
    ctx.register_context_engine(engine)
```

`ContextoEngine.from_env()` returns `None` (matching the `mem0` plugin pattern) when `CONTEXTO_API_KEY` is unset. The classmethod is a thin wrapper:

```python
@classmethod
def from_env(cls) -> "ContextoEngine | None":
    config = ContextoConfig.from_env()
    if config is None:
        return None
    return cls(config)
```

`ContextoConfig.from_env()` (defined in `types.py`) is what actually parses the environment.

### `engine.py` — `ContextoEngine(ContextEngine)`

Implements the standard Hermes ABC:

| Method | Behavior |
|---|---|
| `name` | Returns `"contexto"`. |
| `update_from_response(usage)` | Updates `last_prompt_tokens`, `last_completion_tokens`, `last_total_tokens` from OpenAI-style usage dict. |
| `should_compress(prompt_tokens=None)` | Returns `True` when `prompt_tokens / context_length >= threshold_percent`. Defaults: `threshold_percent=0.75`, `protect_first_n=3`, `protect_last_n=6` (inherited from ABC). |
| `compress(messages, current_tokens=None, focus_topic=None)` | The compaction entry point. See §6. |
| `on_session_start(session_id, **kwargs)` | Stores `session_id` for use as both Contexto's `sessionId` and `sessionKey` (TS pattern: `sessionKey` defaults to `sessionId` when not separately provided). If `session_id` is empty/None, generates a UUID4 fallback. |
| `on_session_end(session_id, messages)` | No-op. The plugin uses per-request `with httpx.Client(...)` so no connection cleanup is needed. |
| `on_session_reset()` | `super().on_session_reset()` resets token counters; clears `self.injected_item_ids`. Does NOT rotate `self.session_id` — Hermes' `/reset` keeps the same session identity per its existing semantics (ContextCompressor pattern). |
| `has_content_to_compress(messages)` | `True` when `non_system_count(messages) > protect_first_n + protect_last_n`. System messages are not counted against head/tail budgets. |
| `update_model(model, context_length, ...)` | Calls `super().update_model(...)` for token-budget recalc, then stores `self.model = model` and `self.provider = provider` (read from kwargs) for use in episode payloads' `runtime_context`. |
| `get_tool_schemas()` | Returns one tool schema for `contexto_search` (see §5 / tools.py). Hermes wires these into the active tool list at session start, wrapping each as `{"type": "function", "function": <schema>}`. |
| `handle_tool_call(name, args, **kwargs)` | Dispatches to `tools.contexto_search(...)` and returns a JSON string. Called by Hermes when the model emits a tool call whose name matches one of our registered schemas. The `messages=<current list>` kwarg is always passed. |
| `get_status()` | Extends ABC default with `auth_state` ("ok"\|"auth_error"\|"degraded") and `last_api_error: str \| None`. Surfaced by Hermes' `/status` command. |

Internal state:
- `session_id: str` (also used as `sessionKey` in payloads; UUID4 fallback if unset)
- `model: str | None`, `provider: str | None` — set by `update_model`; used in episode `runtime_context`.
- `config: ContextoConfig` (loaded from env)
- `client: RemoteBackend`
- `injected_item_ids: set[str]` — dedup across compactions and tool calls in a single session.
- `auth_state: str` (one of `"ok" | "auth_error" | "degraded"`) — observed from `on_error`.
- `last_api_error: str | None` — observed from `on_error`.
- Rate-limit suppression state lives in `RemoteBackend`, not here.

### `client.py` — `RemoteBackend`

Sync `httpx.Client`. Mirror of TS `RemoteBackend`. Per-request client construction (`with httpx.Client(...) as c:`) — no shared connection state, no cleanup obligations.

```python
class RemoteBackend:
    def __init__(
        self,
        config: ContextoConfig,
        on_error: Callable[[ApiError], None],
        on_success: Callable[[], None],
    ):
        # on_error(error) — fires for every non-2xx + suppression entry.
        # on_success() — fires on every 2xx; engine uses this to clear
        # transient `auth_state="degraded"` back to `"ok"`.
        self._rate_limit_reset_at: float | None = None  # backend-owned

    def ingest(self, payloads: list[WebhookPayload]) -> bool:
        # POST /v1/webhooks/events  Authorization: Bearer <apiKey>
        # If self._rate_limit_reset_at is in the future, returns False
        # without making a request (and without calling on_error).
        # On 429, sets self._rate_limit_reset_at from Retry-After header
        # and calls on_error(ApiError(category="ratelimit", ...)).
        # On 2xx, calls on_success() and returns True.
        # Never raises.

    def search(self, query: str, max_results: int,
               filter: dict | None, min_score: float) -> SearchResult | None:
        # Same suppression + success contract as ingest(). Returns None when
        # suppressed. Returns parsed SearchResult on 2xx, None otherwise.
        # Never raises.

@dataclass
class ApiError:
    category: str          # "auth" | "schema" | "ratelimit" | "server" | "network"
    message: str           # log-friendly description
    retry_after: float | None = None   # seconds the backend will suppress calls
```

**Ownership:** rate-limit suppression state lives inside `RemoteBackend` (it's the only thing with HTTP context and the `Retry-After` header). The engine observes errors via `on_error` and successes via `on_success`, both updating `auth_state` / `last_api_error`:

| Event | `auth_state` transition |
|---|---|
| `on_error("auth")` | → `"auth_error"` |
| `on_error("schema" \| "ratelimit" \| "server" \| "network")` | → `"degraded"` (if not already `"auth_error"`) |
| `on_success()` | `"degraded"` → `"ok"`; `"auth_error"` → `"ok"` (key may have been rotated) |

The engine never gates calls itself. Engine→backend boundary stays clean: engine pushes payloads + queries; backend decides whether to send and reports outcomes.

- Base URL: `https://api.getcontexto.com`.
- Headers: `Authorization: Bearer <api_key>`, `Content-Type: application/json`.
- Timeouts (configurable via env): search = 10s (`CONTEXTO_SEARCH_TIMEOUT`), ingest = 30s (`CONTEXTO_INGEST_TIMEOUT`).
- HTTP error categorization is mapped to `ApiError.category` values; the engine's `on_error` callback derives `auth_state` from each category. Full mapping table in §7.

### `helpers.py`

- `strip_metadata_envelope(text: str) -> str` — drops Hermes' metadata prefix if present. Same regex as TS: `^Sender\s*\(untrusted metadata\)\s*:\s*```json\s*[\s\S]*?```\s*` (preserved verbatim from `packages/contexto/src/helpers.ts`).
- `format_search_results(items: list) -> str` — mirrors TS `formatSearchResults`. Produces a `## Relevant Context\n\n...` markdown block with metadata-aware item rendering (summary vs. raw, evidence_refs, trace_ref, status/confidence header).
- `normalize_message_text(message: dict) -> str` — extracts a single text string from a message regardless of shape:
  - `content: str` → return as-is.
  - `content: list[part]` → concatenate `part.text` for parts where `part.type == "text"`. Ignore non-text parts (images, audio).
  - `content: None` (assistant with tool_calls only) → return empty string.
  - Tool-role messages (`role: "tool"`) → use `content` (always string per OpenAI spec).
- `build_episode_payload(messages, session_id, session_key, runtime_context, now=None) -> WebhookPayload` — produces the same payload shape as TS `buildEpisodePayload`. The `now` parameter is an optional zero-arg callable returning a `datetime` for the `timestamp` field; defaults to `lambda: datetime.now(timezone.utc)`. The timestamp is serialized via a custom formatter that emits the TS-style `Z` suffix instead of Python's default `+00:00` (e.g., `"2026-05-22T18:30:00.000Z"`), so fixtures match TS output. Tests inject a frozen clock to compare against TS fixtures (see §9). **Important:** TS uses `JSON.stringify(undefined)` semantics — `undefined` values are OMITTED from the serialized JSON, not serialized as `null`. The Python implementation MUST conditionally exclude None-valued keys to achieve canonical parity:
  ```python
  context: dict[str, Any] = {"sessionId": session_id}
  if runtime_context.get("model") is not None:
      context["model"] = runtime_context["model"]
  if runtime_context.get("provider") is not None:
      context["provider"] = runtime_context["provider"]

  payload: dict[str, Any] = {
      "event": {"type": "episode", "action": "combined"},
      "sessionKey": session_key,
      "timestamp": (now or (lambda: datetime.now(timezone.utc)))().isoformat(),
      "context": context,
      "data": {"messages": messages},  # raw messages preserved unchanged
  }
  # `agent` field omitted entirely (TS passes undefined → omitted)
  return payload
  ```
  Each `compress()` produces a single episode payload from the drop slice, identical to how TS's `default` strategy buffers per turn and ingests on compact. Canonical JSON parity with TS output (not literal byte equality) is enforced by the test in §9.

### `tools.py`

```python
CONTEXTO_SEARCH_SCHEMA = {
    "name": "contexto_search",
    "description": (
        "Search prior conversation context stored in Contexto. Use this to recall "
        "a constraint, decision, or detail from earlier in the conversation that "
        "may no longer be in the active context window. Results are scoped to this "
        "Contexto account."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "query": {"type": "string", "description": "Search query"},
            "max_results": {"type": "integer", "default": 5},
        },
        "required": ["query"],
    },
}
```

`contexto_search(engine, args) -> str`: calls `engine.client.search(...)`, dedups against `engine.injected_item_ids`, formats via `format_search_results`, returns a JSON string with `items` and `paths`.

### `types.py`

Plain dataclasses; no pydantic dependency.

```python
@dataclass
class ContextoConfig:
    api_key: str
    context_enabled: bool = True
    max_context_chars: int = 2000
    min_score: float = 0.45
    max_results: int = 7
    search_timeout: float = 10.0
    ingest_timeout: float = 30.0

    @classmethod
    def from_env(cls) -> "ContextoConfig | None":
        """Read `CONTEXTO_*` env vars. Returns None iff `CONTEXTO_API_KEY` is unset."""
```

The same module exposes `_env_bool(key, default)`, `_env_int(key, default)`, and `_env_float(key, default)`. Each returns the parsed value, or the default on missing/invalid input, with a `WARNING` log when input is present but unparseable. None of them raise — registration must succeed whenever `CONTEXTO_API_KEY` is set, regardless of other env-var hygiene.

### `plugin.yaml`

```yaml
name: contexto
description: Contexto context engine — full episodes + mindmap retrieval (remote)
version: 0.1.0
# Auth and tunables are env-var driven. No YAML config block.
env_vars:
  - name: CONTEXTO_API_KEY
    required: true
    description: API key from getcontexto.com
  - name: CONTEXTO_ENABLED
    default: "true"
  - name: CONTEXTO_MAX_CONTEXT_CHARS
    default: "2000"
  - name: CONTEXTO_MIN_SCORE
    default: "0.45"
  - name: CONTEXTO_MAX_RESULTS
    default: "7"
  - name: CONTEXTO_SEARCH_TIMEOUT
    default: "10"
  - name: CONTEXTO_INGEST_TIMEOUT
    default: "30"
```

## 6. Data flow inside `compress()`

```
         ┌─────────────────────────────────────┐
         │  ContextoEngine.compress(messages)  │
         └─────────────────────────────────────┘
                           │
   ┌───────────────────────┼───────────────────────┐
   ▼                       ▼                       ▼
1. SPLIT              2. INGEST              3. RETRIEVE + ASSEMBLE
protected head/tail   drop slice → API       search(query)
+ "drop slice" mid    POST /v1/webhooks      → format → inject as user+assistant pair
                      /events
                                              ▼
                                         4. TOKEN-INVARIANT CHECK
                                            drop retrieved block
                                            if result is not strictly smaller
```

### Step 1 — Split

- Collect all system messages (role == "system") → kept verbatim, placed first in the returned list.
- From non-system messages: keep first `protect_first_n` (default 3) verbatim.
- Keep last `protect_last_n` (default 6) verbatim.
- Everything in between = the **drop slice**.
- If `len(drop_slice) == 0` → return `messages` unchanged (the should_compress threshold was hit but there's nothing to drop; rare).

### Step 2 — Ingest drop slice

- Build one `WebhookPayload` via `build_episode_payload(messages=drop_slice, session_id=self.session_id, session_key=self.session_id, runtime_context={"model": self.model, "provider": self.provider})`. `session_key` defaults to `session_id` (TS pattern). `runtime_context` values may be `None` if `update_model` hasn't fired yet — `build_episode_payload` strips `None` values; TS treats both fields as optional.
- Single `client.ingest([payload])` call.
- Fail-soft: on failure, the backend invokes the engine's `on_error` callback (which updates `auth_state` / `last_api_error` and logs at `ERROR`). Compaction continues to Step 3.

### Step 3 — Retrieve + assemble

- **If `config.context_enabled` is False, skip Step 3 entirely** — no search, no retrieved-pair injection. Step 4a still runs to produce the trimmed `system + head + tail` candidate. This matches the TS plugin's `contextEnabled: false` semantics: ingestion (Step 2) keeps writing to Contexto, but the engine doesn't read back.
- Query selection:
  - If `focus_topic` is set, use it as-is.
  - Else find the last user-role message in the tail and apply `normalize_message_text(...)` then `strip_metadata_envelope(...)`. If empty, skip Step 3.
- `client.search(query, max_results=config.max_results, filter={"source": "summary"}, min_score=config.min_score)`. The `{"source": "summary"}` filter mirrors the TS plugin's `AbstractContextEngine.assemble`.
- Dedup `result.items` against `self.injected_item_ids`.
- `format_search_results(filtered_items)` → markdown context block.
- Truncate to `config.max_context_chars` (default 2000), appending `…` if cut.
- **Wrap retrieved context as a synthetic user+assistant pair** (matching TS `assembleContextMessages`):
  ```python
  [
    {"role": "user", "content": [{"type": "text", "text": "[Recalled context from previous conversations]"}]},
    {"role": "assistant", "content": [{"type": "text", "text": context_block}]},
  ]
  ```
  Rationale: a system message late in the conversation can confuse models that expect system messages only at the head; a synthetic user/assistant turn is treated as normal dialogue.

### Step 4 — Invariant checks

Two checks, applied in order:

**4a. Message-count guard.** The retrieved_pair adds 2 messages. To preserve strict message-count reduction, ONLY inject the retrieved_pair when `len(drop_slice) >= 3`. If `len(drop_slice) < 3`, skip injection — return `system_messages + head + tail` directly (strictly fewer messages than input).

**4b. Token-invariant check** (only runs when 4a allowed injection):
- Assemble candidate list: `system_messages + head + retrieved_pair + tail`.
- Estimate tokens for `messages` (input) and `candidate` (output). Estimator: `tiktoken` for `gpt-*` model families, else `len(text) // 4` heuristic. **Estimates are approximate** — they don't account for model-specific message-envelope overhead.
- If `estimate(candidate) >= estimate(messages)`:
  - Drop the `retrieved_pair`. Return `system_messages + head + tail`.
- Otherwise, return `candidate`.

Record `item.id` for each injected item in `self.injected_item_ids` only if the retrieved pair survives both checks.

### Invariant

When `should_compress()` returned `True` and Step 1 produced a non-empty drop slice, `compress()` returns:
- **Strictly fewer messages** than the input (Step 4a's gate ensures this in both branches).
- **Non-increasing estimated tokens** vs the input (Step 4b drops the retrieved pair if it would grow tokens).

Strict token reduction is not guaranteed for pathological slices (all-empty tool messages, etc.). The message-count invariant alone bounds the loop — convergence after at most `len(messages) - protect_first_n - protect_last_n` compactions. Hermes' real-tokenizer threshold check on the next turn re-triggers `compress()` against a now-smaller list if needed.

## 7. Error handling

Fail-soft for all external calls. Contexto must never break the agent.

| Failure | HTTP / category | Behavior |
|---|---|---|
| `CONTEXTO_API_KEY` unset | — | `ContextoConfig.from_env()` returns `None`, so `register()` returns without calling `ctx.register_context_engine`. The context-engine loader's `_load_engine_from_dir` consequently returns `None`, and `discover_context_engines()` reports `contexto` as unavailable. If the user selected `context.engine: contexto` anyway, Hermes' `load_context_engine` returns `None` and the runtime falls back to the default `compressor` engine. The plugin logs the missing-key reason at `ERROR` during `register()` so it surfaces in plugin load logs. |
| Auth | 401, 403 | Log `ERROR` with "check CONTEXTO_API_KEY". Set `auth_state="auth_error"`, `last_api_error=...`. Skip the current op. Future calls still attempted (key may have been rotated). |
| Schema | 422 | Log `ERROR` with response body. Set `auth_state="degraded"`. Skip the current op. |
| Rate limit | 429 | Log `WARNING`. Honor `Retry-After` header by skipping calls until the deadline. Set `auth_state="degraded"` while suppressed, back to `"ok"` after first successful call. |
| Server | 5xx | Log `ERROR`. Set `auth_state="degraded"`. Skip the current op. |
| Network / timeout | — | Log `ERROR`. Same as 5xx. |
| Ingest fails | any | `compress()` Step 3 still runs (retrieval). Step 4 enforces token reduction. |
| Search fails | any | `compress()` Step 4 falls back to head+tail (no retrieved block). |
| Search returns empty / all dedup'd | — | No retrieved-context pair. Step 4 falls back to head+tail. |
| No usable query | — | Skip Step 3. Step 2 still runs. |

Logger: `logging.getLogger("plugins.context_engine.contexto")`. `ERROR` for failures, `WARNING` for rate limit / silent degradations, `INFO` for lifecycle, `DEBUG` for payloads.

`get_status()` exposes `auth_state` and `last_api_error` so the `/status` slash command can surface Contexto health to the user.

## 8. Configuration

User selects the engine the standard Hermes way:

```yaml
# ~/.hermes/config.yaml
context:
  engine: contexto
```

Everything else is env-var driven (§5 / `ContextoConfig.from_env`). The plugin reads nothing from `config.yaml` itself. This avoids a Hermes-config-injection plumbing problem that the `_EngineCollector` loader doesn't support, and matches how the `mem0` memory plugin handles its own config.

Required: `CONTEXTO_API_KEY`. Everything else optional with defaults.

## 9. Testing

Three layers.

### Unit (no network)

- `RemoteBackend.ingest/search` with `httpx.MockTransport`: verify URL, headers, body shape, timeouts, fail-soft on each HTTP error class (401/403/422/429/5xx/network). Verify 429 sets `_rate_limit_reset_at` and suppresses subsequent calls without invoking `on_error` again until the deadline passes.
- `build_episode_payload`: **canonical JSON parity** with a TS fixture. (Not literal byte equality — TS and Python serializers differ on key order, whitespace, and Unicode escaping. We compare canonical forms by re-serializing both sides with `json.dumps(..., sort_keys=True, ensure_ascii=False)`.) Fixture is generated once by running the TS `buildEpisodePayload` against canned inputs with a frozen timestamp, checked into `tests/fixtures/`. The Python `build_episode_payload` accepts an injectable `now: Callable[[], datetime]` parameter (default `lambda: datetime.now(timezone.utc)`) so the test can freeze the clock to match the fixture's `timestamp` field.
- `helpers.strip_metadata_envelope`, `format_search_results`, `normalize_message_text`: table-driven, with cases for string/multipart/null content, tool_calls, tool-role messages.
- `ContextoEngine.compress` with a stub backend: split logic, drop slice construction, token-invariant fallback when retrieved block makes the result larger, dedup updates, `focus_topic` override.

### ABC compliance

Following the official doc's template:
- `isinstance(engine, ContextEngine)`, `engine.name == "contexto"`.
- `compress(msgs)` returns a list of role-bearing dicts.
- **Strict message-count reduction:** `len(result) < len(msgs)` (always holds — see §6 invariant).
- **Non-increasing estimated tokens:** `estimate_tokens(result) <= estimate_tokens(msgs)`.
- **Strict token reduction** in the normal path: separate test against a text-heavy conversation asserts `estimate_tokens(result) < estimate_tokens(msgs)`.
- `should_compress` at boundary ratios; `on_session_reset` clears `injected_item_ids`; `has_content_to_compress` counts only non-system messages; Step 4a gate (drop_slice < 3 → no retrieved pair).

### Smoke (live, opt-in)

- Gated on `CONTEXTO_API_KEY` env var (skipped if unset).
- Round-trip: ingest a synthetic episode, search with a known query, assert non-empty result.
- Tool round-trip: invoke `contexto_search` via the engine's `handle_tool_call`.
- Runs in CI only on `main` to avoid spamming the API on every PR.

Pytest only. `pyproject.toml` declares `pytest`, `httpx`, and `tiktoken` as test deps.

## 10. Known v1 limitations

1. **No per-turn retrieval injection.** Hermes' ABC has no before-LLM-call hook. The `contexto_search` tool is the v1 substitute, but it depends on the model calling it.
2. **Ingestion only on compaction.** Sessions that never cross the threshold contribute nothing to Contexto. Matches the TS plugin's `default` strategy — not a Hermes-specific regression.
3. **Install requires writing into hermes-agent's bundled tree.** `$HERMES_HOME/plugins/` is not scanned for context engines. Widening that is a future upstream PR.
4. **Token estimation is approximate.** `tiktoken` for OpenAI families, `len(text) // 4` heuristic otherwise. The §6 Step 4 fallback is still correct, may just over-shrink.
5. **No `sliding-window` token-budget eviction.** Uses fixed `protect_first_n` / `protect_last_n`.
6. **Image/audio-only user turns skip retrieval.** No text → no query. The drop slice is still ingested with multimodal content preserved.
7. **`install` command may need re-running on Hermes upgrades.** The bundled tree gets wiped; `rm -rf <plugins-dir>/contexto` is the uninstall.

## 11. Future enhancements (post-v1)

- **Per-turn ingestion + retrieval injection** via an upstream Hermes ABC extension (`after_turn(messages)` and/or `augment_messages(messages, prompt)`). Would close the gap with TS `afterTurn` / `assemble`.
- **`contexto_ingest` tool** as a v1.1 stopgap for ingestion-between-compactions (agents are unreliable at calling "save this" tools, so this is lower priority than the ABC extension).
- **Local backend** (TS-parity mindmap + LLM summarization).
- **`sliding-window` token-budget eviction.**
- **`on_session_start` warm-up.** Pre-fetch top relevant context at session start when resuming a known `session_id`.
- **Widen Hermes context-engine discovery path** to include `$HERMES_HOME/plugins/context_engine/`.

## 12. Open items to resolve during plan phase

1. **PyPI name availability.** Confirm `contexto-hermes` is available; if not, fall back to `ekai-contexto-hermes`.

2. **`update_from_response` usage dict shape.** Confirm Hermes passes the OpenAI-style `{"prompt_tokens", "completion_tokens", "total_tokens"}` dict (matching `ContextCompressor.update_from_response`).

3. **`/status` integration.** Confirm Hermes' `/status` slash command surfaces `context_compressor.get_status()` extra fields (`auth_state`, `last_api_error`) — or, if it doesn't, decide whether to log them at `INFO` instead.

## 13. Hermes runtime contract assumptions

The design assumes these behaviors of the Hermes runtime. They were confirmed against the current implementation at the time of writing.

- **Loader fallback.** When `context.engine: <name>` is set but the named engine fails to load (e.g., our `register()` returned without registering because `CONTEXTO_API_KEY` was unset), Hermes logs a WARNING and falls back to the built-in `ContextCompressor`. The plugin's missing-key error log appears in plugin-load logs.
- **`update_model` timing.** Hermes calls `update_model(model, context_length, base_url, api_key, provider=...)` immediately after engine selection and before the first `compress()` or LLM call. `provider` is passed as a kwarg.
- **Context engine tool wiring.** At session start, Hermes iterates `get_tool_schemas()`, wraps each result as `{"type": "function", "function": <schema>}`, and adds them to the active tool list. Tool calls matching those names dispatch to `handle_tool_call(name, args, messages=...)`.
- **`on_session_start` invocation.** Called early with `(session_id, hermes_home=..., platform=..., model=..., context_length=...)`. `session_id` is always non-empty.
- **Context engine plugin context.** Plugins under `plugins/context_engine/<name>/` receive a stripped-down context that supports only `register_context_engine`. Tool / hook / CLI registration are not available via this slot; tools must be exposed through `get_tool_schemas()` on the engine class itself.
