# Ekai Gateway

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub stars](https://img.shields.io/github/stars/ekailabs/ekai-gateway.svg?style=social)](https://github.com/ekailabs/ekai-gateway)
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?logo=discord&logoColor=white)](https://discord.com/invite/5VsUUEfbJk)

Archieved Repo:
For our latest work, check https://github.com/ekailabs/contexto

Multi-provider AI proxy with usage dashboard supporting Anthropic, OpenAI, Google Gemini, xAI, and OpenRouter models through OpenAI-compatible and Anthropic-compatible APIs.

**Designed for self-hosted personal use** — run your own instance using your OpenRouter API key.

## Features

- 🔀 **OpenRouter proxy**: Full OpenAI-compatible `/v1/chat/completions` endpoint
- 🧠 **Embedded memory**: Automatically stores and injects relevant context from past conversations
- 📊 **Memory dashboard**: Browse, search, and manage stored memories
- 🔑 **BYOK**: Bring your own OpenRouter API key — or pass a key per-request

## Quick Start

**Option 1: npm**
```bash
npm install
cp .env.example .env
# Add OPENROUTER_API_KEY to .env
npm run build
npm start
```

**Option 2: Docker (published image)**
```bash
cp .env.example .env
# Add OPENROUTER_API_KEY to .env
docker compose up -d
```

**Access points (default ports):**
- OpenRouter proxy + memory APIs: port `4010` (`OPENROUTER_PORT`)
- Memory dashboard: port `3000` (`UI_PORT`)

### Build the image yourself (optional)

```bash
docker build --target ekai-cloudrun -t ekai-gateway .
docker run --env-file .env -p 4010:4010 ekai-gateway
```

## Usage

Point any OpenAI-compatible client at `http://localhost:4010`:

```bash
# Chat completions — memory is injected automatically
curl -X POST http://localhost:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "anthropic/claude-sonnet-4-5", "messages": [{"role": "user", "content": "Hello"}]}'

# Pass your own OpenRouter key per-request
curl -X POST http://localhost:4010/v1/chat/completions \
  -H "Authorization: Bearer sk-or-..." \
  -H "Content-Type: application/json" \
  -d '{"model": "openai/gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'

# Health check
curl http://localhost:4010/health
```

## Running Services

### npm (local development)

```bash
npm run dev    # dashboard + openrouter with hot-reload
npm start      # production mode
```

Disable individual services via env:
```bash
ENABLE_DASHBOARD=false npm run dev      # openrouter only
ENABLE_OPENROUTER=false npm run dev     # dashboard only
```

### Docker

```bash
docker compose up -d    # start all services
docker compose logs -f  # view logs
docker compose down     # stop
```

**Docker service toggles (`.env`):**
```bash
ENABLE_DASHBOARD=true    # memory dashboard (default: true)
ENABLE_OPENROUTER=true   # proxy + memory APIs (default: true)
```

## Project Structure

```
ekai-gateway/
├── store/                # JSONL event storage library (@ekai/store)
├── integrations/
│   ├── openrouter/       # Proxy server with embedded memory (@ekai/openrouter)
│   └── openclaw/         # OpenClaw lifecycle plugin (@ekai/contexto)
├── memory/               # Agent memory library (@ekai/memory)
├── ui/dashboard/         # Memory management dashboard (Next.js)
├── scripts/
│   └── launcher.js       # Unified service launcher
└── package.json          # Root workspace configuration
```

## OpenClaw Plugin

[`@ekai/contexto`](https://www.npmjs.com/package/@ekai/contexto) is an OpenClaw plugin that captures all 13 lifecycle events to structured JSONL storage (powered by [`@ekai/store`](./store/)). Install it in any OpenClaw instance:

```bash
openclaw plugins install @ekai/contexto
```

Configure in your OpenClaw config:
```json5
{
  plugins: {
    allow: ["ekai-contexto"],
    entries: {
      "ekai-contexto": {
        enabled: true,
        config: { "dataDir": "~/.openclaw/ekai/data" }
      }
    }
  }
}
```

See [`integrations/openclaw/`](./integrations/openclaw/) for source and details.

## Beta Testing Notes

🚧 **This is a beta release** — please report issues and feedback!

**Getting help:**
- Join the [Discord](https://discord.com/invite/5VsUUEfbJk)
- Check logs with `docker compose logs -f`
- Ensure your OpenRouter API key has sufficient credits

## Contributing

Contributions are highly valued and welcomed! See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License
Licensed under the [Apache License 2.0](./LICENSE).
