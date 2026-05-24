"""The `contexto_search` engine tool — schema + handler.

Exposed via `ContextoEngine.get_tool_schemas()`; dispatched by Hermes when the
model emits a tool call whose name matches the schema.
"""

from __future__ import annotations

import json
from typing import Any

from .helpers import format_search_results

CONTEXTO_SEARCH_SCHEMA: dict[str, Any] = {
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

_DEFAULT_MAX_RESULTS = CONTEXTO_SEARCH_SCHEMA["parameters"]["properties"]["max_results"]["default"]
_MAX_RESULTS_CAP = 50


def _item_id(entry: Any) -> str | None:
    if not isinstance(entry, dict):
        return None
    if "item" in entry and isinstance(entry["item"], dict):
        return entry["item"].get("id")
    return entry.get("id")


def _coerce_query(raw: Any) -> str:
    """Best-effort query coercion. Empty string means 'skip the search'."""
    if raw is None:
        return ""
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, (int, float, bool)):
        return str(raw).strip()
    return ""


def _coerce_max_results(raw: Any) -> int:
    """Coerce a model-supplied max_results to a valid int in [1, _MAX_RESULTS_CAP]."""
    if raw is None:
        value = _DEFAULT_MAX_RESULTS
    else:
        try:
            value = int(raw)
        except (TypeError, ValueError):
            value = _DEFAULT_MAX_RESULTS
    if value < 1:
        return 1
    if value > _MAX_RESULTS_CAP:
        return _MAX_RESULTS_CAP
    return value


def _degraded(note: str) -> str:
    import json
    return json.dumps({
        "context": "",
        "items": [],
        "paths": [],
        "status": "degraded",
        "note": note,
    })


def contexto_search(engine: Any, args: dict[str, Any]) -> str:
    """Handle a `contexto_search` tool call. Returns a JSON string.

    Calls `engine.client.search(...)` with the `{"source": "summary"}` filter
    (matching the TS plugin's `AbstractContextEngine.assemble`). Filters out
    items already injected this session, then returns `{items, paths}`.

    Fail-soft: malformed model-supplied args (null, wrong types, missing keys)
    never raise — they return a degraded-status JSON instead.
    """
    if not isinstance(args, dict):
        return _degraded("contexto_search received non-object arguments")

    query = _coerce_query(args.get("query"))
    if not query:
        return _degraded("contexto_search called without a usable query")

    max_results = _coerce_max_results(args.get("max_results"))

    result = engine.client.search(
        query,
        max_results=max_results,
        filter={"source": "summary"},
        min_score=engine.config.min_score,
    )

    if result is None:
        return json.dumps({
            "context": "",
            "items": [],
            "paths": [],
            "status": "degraded",
            "note": "Contexto search unavailable (auth, rate-limit, or network).",
        })

    filtered_items = [
        entry for entry in result.items
        if (item_id := _item_id(entry)) is None or item_id not in engine.injected_item_ids
    ]

    # Record IDs of items we're returning so future compactions and tool calls
    # dedup against them (spec §5: dedup across compactions AND tool calls).
    for entry in filtered_items:
        item_id = _item_id(entry)
        if item_id is not None:
            engine.injected_item_ids.add(item_id)

    context = format_search_results(filtered_items) if filtered_items else ""
    if engine.config.max_context_chars > 0 and len(context) > engine.config.max_context_chars:
        context = context[: engine.config.max_context_chars] + "…"

    return json.dumps({
        "context": context,
        "items": filtered_items,
        "paths": list(result.paths),
    })
