# contexto (Python)

Python client for the self-hosted Contexto memory API. Targets the OSS memory engine exposed by `packages/openrouter` (default port 4010).

> This client is for the **self-hosted** stack only. The hosted `api.getcontexto.com` API has a different surface (mindmap-based) and is not supported here.

## Install

```bash
pip install "contexto @ git+https://github.com/amiller/contexto.git#subdirectory=clients/python"
```

Or for local dev:

```bash
pip install -e clients/python/
```

## Usage

```python
from contexto import ContextoClient

ctx = ContextoClient(base_url="http://localhost:4010")

# Register an agent (idempotent on the slug)
ctx.register_agent("hermes", name="Hermes")

# Ingest a turn
ctx.ingest(
    messages=[
        {"role": "user", "content": "My data center has 12 server racks."},
        {"role": "assistant", "content": "Got it — 12 racks."},
    ],
    agent="hermes",
    user_id="alex",
)

# Multi-sector cognitive memory query
result = ctx.search("how many racks", agent="hermes", user_id="alex")
# -> {"workingMemory": [...], "perSector": {...}, "agentId": "hermes"}

# Or a formatted block ready for prompt injection
block = ctx.get_context_for_turn("how many racks", agent="hermes", user_id="alex")
```

## Endpoints used

- `POST /v1/agents` — register an agent
- `POST /v1/ingest` — ingest `{messages, agent, userId}`
- `POST /v1/search` — query `{query, agent, userId}`
- `GET  /v1/summary` — recent memories
