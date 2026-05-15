# Using Gateway with Codex

This guide walks through configuring Codex to use ekai-gateway for unified multi‑provider access and detailed usage analytics.

## Why Use the Gateway
- Single endpoint for OpenAI, Anthropic, xAI, and OpenRouter
- Consistent chat completions API surface
- Centralized usage and cost tracking at `http://localhost:3000`

## Prerequisites
- Node.js 18+ and npm
- Codex installed
- API keys for any providers you plan to use

## Install and Run the Gateway
```bash
git clone https://github.com/ekailabs/contexto.git
cd contexto
pnpm install
pnpm run dev
```

## Configure Environment
Copy and edit `.env` with your keys:
```bash
cp .env.example .env
# Edit .env and set any of:
# OPENAI_API_KEY=...
# ANTHROPIC_API_KEY=...
# XAI_API_KEY=...
# OPENROUTER_API_KEY=...
# Optional
# PORT=3001        # Gateway API port (v1 under this)
# UI_PORT=3000     # Dashboard port
```

## Option A: Quick Start via Environment
Point Codex to the gateway’s OpenAI‑compatible endpoint:
```bash
export OPENAI_BASE_URL="http://localhost:3001/v1"
codex
```

Use `--model` to pick a specific model routed by the gateway:
```bash
codex --model "gpt-4o"                    # OpenAI
codex --model "grok-code-fast-1"          # xAI
codex --model "claude-sonnet-4-20250514"  # Anthropic
```

## Option B: Codex config.toml (Recommended)
Set `model_provider = "ekai"` and define an ekai provider pointing to the gateway chat API.

`$CODEX_HOME/config.toml` (defaults to `~/.codex/config.toml`):
```toml
model_provider = "ekai"

[model_providers.ekai]
name = "Ekai Gateway"
base_url = "http://localhost:3001/v1"
wire_api = "chat"
```

Run Codex with your desired model(s):
```bash
codex --model "gpt-4o"              
codex --model "grok-code-fast-1"    
codex --model "claude-sonnet-4-20250514"
```

## Monitor Usage
- Open `http://localhost:3000` to view token usage, spend, and trends.
- Filter by provider/model to compare costs.

## Troubleshooting
- 401/403 errors: ensure the corresponding provider API key is set in `.env` and has access to the selected model.
- 404/Model not found: confirm the model name is supported and correctly spelled.
- Network errors: verify `pnpm run dev` is running and `OPENAI_BASE_URL`/`base_url` points to the correct port.
