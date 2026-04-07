# Add Memory to Your OpenRouter Proxy

## Quick Start (pre-built image)

```sh
docker run -d --name ekai \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e MEMORY_EMBED_PROVIDER=openrouter \
  -e MEMORY_EXTRACT_PROVIDER=openrouter \
  -p 3000:3000 \
  -p 4010:4010 \
  ghcr.io/ekailabs/ekai-gateway:latest
```

## Build from Source

```sh
docker build -t ekai-gateway .
docker run -d --name ekai \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e MEMORY_EMBED_PROVIDER=openrouter \
  -e MEMORY_EXTRACT_PROVIDER=openrouter \
  -p 3000:3000 \
  -p 4010:4010 \
  ekai-gateway
```

### Environment

| Variable | Required | Default |
|----------|----------|---------|
| `OPENROUTER_API_KEY` | Yes | — |
| `MEMORY_EMBED_PROVIDER` | Yes | `gemini` |
| `MEMORY_EXTRACT_PROVIDER` | Yes | `gemini` |
| `OPENROUTER_EMBED_MODEL` | No | `openai/text-embedding-3-small` |
| `OPENROUTER_EXTRACT_MODEL` | No | `openai/gpt-4o-mini` |
| `MEMORY_DB_PATH` | No | `./memory.db` |

## Verify

```sh
# 1. Health
curl localhost:4010/health

# 2. Chat — sends a message and triggers memory ingest
curl localhost:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "openai/gpt-4o-mini",
    "user": "clay-test",
    "messages": [{"role": "user", "content": "I believe futarchy is the future of investing. Prediction markets should replace traditional governance for capital allocation decisions."}]
  }'

# 3. Confirm memory was stored
curl "localhost:4010/v1/summary?profile=clay-test"
```

Expected: summary shows counts > 0 in episodic and/or semantic sectors.

## Dashboard

Open http://localhost:3000 to browse the Memory Vault UI.
