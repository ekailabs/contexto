# Using Gateway with Claude Code

This guide shows how to run Claude Code through ekai-gateway for multi‑provider routing, unified configuration, and detailed usage analytics.

## What You Get
- Single endpoint for Anthropic, OpenAI, xAI, and OpenRouter
- Automatic model routing based on model name
- Usage and cost analytics at `http://localhost:3000`
- Works with standard Claude Code env vars

## Prerequisites
- Node.js 18+ and npm
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
# ANTHROPIC_API_KEY=...
# OPENAI_API_KEY=...
# XAI_API_KEY=...
# OPENROUTER_API_KEY=...
# Optional
# PORT=3001        # Gateway API port
# UI_PORT=3000     # Dashboard port
```

## Point Claude Code at the Gateway
Claude Code uses `ANTHROPIC_*` variables. Set the base URL to the gateway and choose a model name; the gateway will route it to the right provider.
```bash
# Point Claude Code to ekai-gateway
export ANTHROPIC_BASE_URL="http://localhost:3001"

# Pick a model (examples)
export ANTHROPIC_MODEL="claude-sonnet-4-20250514"   # Anthropic
export ANTHROPIC_MODEL="gpt-4o"                     # OpenAI
export ANTHROPIC_MODEL="grok-code-fast-1"           # xAI
export ANTHROPIC_MODEL="moonshotai/kimi-k2"         # OpenRouter

# Start Claude Code
claude
```

Notes
- Set only one `ANTHROPIC_MODEL` at a time per session.
- You can run multiple Claude Code sessions with different models by setting different envs per terminal.

## Verify and Monitor
- Hit the dashboard at `http://localhost:3000` to see token usage, costs, and model/provider breakdowns.
- Check gateway logs in the terminal for request details.

## Troubleshooting
- 401/403 errors: verify the relevant API key is present in `.env` and the provider allows the chosen model.
- Connection refused: ensure `pnpm run dev` is active and `ANTHROPIC_BASE_URL` matches the gateway port.
- Model not found: confirm the model name is supported by its provider and spelled correctly.
