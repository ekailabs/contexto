# Ekai Documentation

> Ekai is the universal context layer for agentic AI. Below you’ll find quick links to get started and learn more.

[![GitHub - ekailabs/ekai-gateway](https://img.shields.io/badge/GitHub-ekailabs%2Fekai--gateway-181717?logo=github&logoColor=white)](https://github.com/ekailabs/ekai-gateway)

- [Getting Started](getting-started.md)
- [Architecture Overview](architecture-overview.md)
- [Usage with Claude Code](USAGE_WITH_CLAUDE_CODE.md)
- [Usage with Codex](USAGE_WITH_CODEX.md)
- [Providers and Models](providers-and-models.md)
- [Get Started with x402](GET_STARTED_WITH_X402.md)

## What is Ekai?

Ekai is the **universal context layer for agentic AI** — a unified gateway and memory system that makes your LLM context portable across models, providers, and interfaces.

Today, every model and interface operates in isolation. Switching from Claude Code to Codex, or between different chat and coding environments, means losing continuity: prompts, memory, and workflow context. Ekai solves this by providing a single gateway that connects to multiple providers while keeping your usage, data, and context under your control.

	

## What is the Ekai Gateway?

The **Ekai Gateway** is a self-hosted multi-provider API layer that lets you route LLM requests to different providers and models through one endpoint. Think of using xAI's models in Codex, or using OpenAI's models in Claude Code.

It is fully compatible with both **OpenAI** and **Anthropic** APIs, supports **Google Gemini**, **OpenRouter**, **xAI**, and others, and includes built-in **usage tracking** and **cost analytics** through a lightweight dashboard.

It also supports **x402 pay-for-inference**: when a requested model doesn’t have a local API key, the Gateway can route via x402 Rasta, settle fees on‑chain in stablecoins, and relay the response from the appropriate provider.

With the Gateway, you can:
- Use one unified endpoint for all supported providers  
- Keep your own API keys and billing under control  
- Monitor requests, tokens, and costs per provider  
- Switch models and interfaces instantly without losing context  

	

## Why It Matters

Ekai removes vendor lock in and enables context portability.
Developers and teams can integrate multiple models into their workflows, research tools, or products with full transparency and control.

### Why switch models?

Different situations call for different models. The Gateway makes it easy to switch based on:
- Rate limits: route to another provider when you hit caps
- Cost vs performance: use cheaper models for drafts, stronger ones for finals
- Capability fit: pick models optimized for code, reasoning, images, or tools
- Latency/region: prefer the fastest or region‑local provider
- Evaluation: A/B test outputs across models with identical context

By decoupling your context from any single provider or interface, the Gateway makes AI interactions persistent, interoperable, and owned by you.

## Key Features and Benefits

- **Unified Gateway:** One endpoint for OpenAI, Anthropic, Google, xAI, and OpenRouter  
- **OpenAI and Anthropic Compatibility:** Works with standard API formats used by most clients  
- **Self-Hosted Control:** Run locally or in your own environment; no external dependencies  
- **Usage Analytics:** Built-in dashboard for tracking tokens, requests, and costs  
- **Context Portability:** Maintain continuity when switching models or interfaces
- **Memory Loop:** Conversations are automatically ingested and recalled across sessions — no client changes needed
- **Cost-Optimized Routing:** Automatically select the most efficient provider for each model
- **Transparent Billing:** Use your own API keys for full visibility and ownership  


## How the Gateway Fits In Ekai's Vision

The Gateway is the first step toward Ekai’s broader vision: giving users and agents **sovereign control over their intelligence**.  
It establishes the foundation for portable context — the ability for memory, reasoning, and identity to travel freely across models and environments.  

Future layers of Ekai will build on this foundation to enable shared memory, unified billing, and ultimately **sovereign agents** — digital entities that act on behalf of their users, powered by context they truly own.
