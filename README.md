# Ekai Gateway

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)
[![GitHub stars](https://img.shields.io/github/stars/ekailabs/ekai-gateway.svg?style=social)](https://github.com/ekailabs/ekai-gateway)
[![Discord](https://img.shields.io/badge/Discord-Join%20Server-7289da?logo=discord&logoColor=white)](https://discord.com/invite/5VsUUEfbJk)

Archieved Repo:
For our latest work, check https://github.com/ekailabs/contexto


Multi-provider AI proxy with usage dashboard supporting Anthropic, OpenAI, Google Gemini, xAI, and OpenRouter models through OpenAI-compatible and Anthropic-compatible APIs.

**Designed for self-hosted personal use** - run your own instance to securely proxy AI requests using your API keys.

## Features

- 🤖 **Multi-provider**: Anthropic + OpenAI + Google (Gemini) + xAI + OpenRouter models
- 🔄 **Dual APIs**: OpenAI-compatible + Anthropic-compatible endpoints
- 🔀 **Cost-optimized routing**: Automatic selection of cheapest provider for each model
- 💰 **Usage tracking**: Track token usage and costs with visual dashboard
- 🗄️ **Database storage**: SQLite database for persistent usage tracking
- 📊 **Analytics dashboard**: Real-time cost analysis and usage breakdowns

## 🎥 Demo Video

<a href="https://youtu.be/hZC1Y_dWdhI" target="_blank">
  <img src="https://img.youtube.com/vi/hZC1Y_dWdhI/0.jpg" alt="Demo Video" width="560" height="315">
</a>

## Quick Start (Beta)

**Option 1: Using npm**
```bash
# 1. Install dependencies
npm install

# 2. Setup environment variables
cp .env.example .env
# Edit .env and add at least one API key (see .env.example for details)

# 3. Build and start the application
npm run build
npm start
```

**Option 2: Using Docker (published image)**
```bash
# 1. Setup environment variables
cp .env.example .env
# Edit .env and add at least one API key (see .env.example for details)

# 2. Pull + start the latest GHCR image
docker compose up -d

# Optional: run without Compose
docker pull ghcr.io/ekailabs/ekai-gateway:latest
docker run --env-file .env -p 3001:3001 -p 3000:3000 ghcr.io/ekailabs/ekai-gateway:latest
```

Important: The dashboard is initially empty. After setup, send a query using your own client/tool (IDE, app, or API) through the gateway; usage appears once at least one request is processed.

**Access Points:**
- Gateway API: `http://localhost:3001`
- Dashboard UI: `http://localhost:3000`
- Detailed setup steps live in `docs/getting-started.md`; check `docs/` for additional guides.

### Build the Image Yourself (optional)

If you’re contributing changes or need a custom build:

```bash
docker build --target ekai-gateway-runtime -t ekai-gateway .
docker run --env-file .env -p 3001:3001 -p 3000:3000 ekai-gateway
```

## Populate the Dashboard

- Point your client/tool to the gateway (`http://localhost:3001` or `http://localhost:3001/v1`), see integration guides below.
- Send a query using your usual workflow; both OpenAI-compatible and Anthropic-compatible endpoints are tracked.
- Open `http://localhost:3000` to view usage and costs after your first request.

**Required:** At least one API key from Anthropic, OpenAI, Google Gemini, xAI, or OpenRouter (see `.env.example` for configuration details).

## Integration Guides

### 🤖 **Claude Code Integration**
Use the gateway with Claude Code for multi-provider AI assistance:

```bash
# Point Claude Code to the gateway
export ANTHROPIC_BASE_URL="http://localhost:3001"
export ANTHROPIC_MODEL="grok-code-fast-1"  # or "gpt-4o","claude-sonnet-4-20250514"

# Start Claude Code as usual
claude
```

📖 **[Complete Claude Code Guide →](./docs/USAGE_WITH_CLAUDE_CODE.md)**

### 💻 **Codex Integration** 
Use the gateway with Codex for OpenAI-compatible development tools:

```bash
# Point Codex to the gateway
export OPENAI_BASE_URL="http://localhost:3001/v1"

# Start Codex as usual  
codex
```

📖 **[Complete Codex Guide →](./docs/USAGE_WITH_CODEX.md)**
## Beta Testing Notes

🚧 **This is a beta release** - please report any issues or feedback!

**Known Limitations:**
- Some edge cases in model routing may exist

**Getting Help:**
- Check the logs in `gateway/logs/gateway.log` for debugging
- Ensure your API keys have sufficient credits
- Test with simple requests first before complex workflows

## Project Structure

```
ekai-gateway/
├── gateway/          # Backend API and routing
├── ui/              # Dashboard frontend
├── shared/          # Shared types and utilities
└── package.json     # Root package configuration
```

## API Endpoints

```bash
POST /v1/chat/completions  # OpenAI-compatible chat endpoint
POST /v1/messages          # Anthropic-compatible messages endpoint
POST /v1/responses         # OpenAI Responses endpoint
GET  /usage               # View token usage and costs
GET  /health              # Health check endpoint
```

```bash
# OpenAI-compatible endpoint (works with all providers)
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o", "messages": [{"role": "user", "content": "Hello"}]}'

# Use Claude models via OpenAI-compatible endpoint
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "messages": [{"role": "user", "content": "Hello"}]}'

# Use xAI Grok models
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "grok-code-fast", "messages": [{"role": "user", "content": "Hello"}]}'

# Anthropic-compatible endpoint
curl -X POST http://localhost:3001/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model": "claude-3-5-sonnet-20241022", "max_tokens": 100, "messages": [{"role": "user", "content": "Hello"}]}'

# OpenAI Responses endpoint
curl -X POST http://localhost:3001/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "input": "Say hi in one short sentence.", "temperature": 0.7, "max_output_tokens": 128}'

# Both endpoints support all models and share conversation context
# Client A uses OpenAI format, Client B uses Anthropic format - same conversation!

# Check usage and costs
curl http://localhost:3001/usage
```

## Model Routing (Cost-Optimized)

The proxy uses **cost-based optimization** to automatically select the cheapest available provider:

1. **Special routing**: Grok models (`grok-code-fast`, `grok-beta`) → xAI (if available)
2. **Cost optimization**: All other models are routed to the cheapest provider that supports them
3. **Provider fallback**: Graceful fallback if preferred provider is unavailable

**Supported providers**:
- **Anthropic**: Claude models (direct API access)
- **OpenAI**: GPT models (direct API access)
- **xAI**: Grok models (direct API access)
- **OpenRouter**: Multi-provider access with `provider/model` format

**Multi-client proxy**: Web apps, mobile apps, and scripts share conversations across providers with automatic cost tracking and optimization.

## Production Commands

```bash
npm run build  # Build TypeScript for production
npm start      # Start both gateway and dashboard
```

**Individual services:**
```bash
npm run start:gateway  # Gateway API only (port 3001)
npm run start:ui       # Dashboard UI only (port 3000)
```

## Development

```bash
npm run dev    # Start both gateway and dashboard in development mode
```

**Individual services:**
```bash
cd gateway && npm run dev    # Gateway only (port 3001)
cd ui/dashboard && npm run dev    # Dashboard only (port 3000)
```

## Contributing

Contributions are highly valued and welcomed! See [CONTRIBUTING.md](./CONTRIBUTING.md) for details.

## License
Licensed under the [Apache License 2.0](./LICENSE).
