# How Contexto Works

Contexto is designed as a **single install solution for all your context needs in OpenClaw**. It acts as a powerful hybrid knowledge retrieval plugin that seamlessly enhances your agent's memory.

Currently, Contexto fuses your standard SQLite memory with a local Markdown Obsidian vault using QMD. However, the ultimate goal is to extend Contexto to support multiple ways of fetching relevant context in the near future—including an upcoming integration with **Google Drive**.

This document explains the core architecture and workflow of the current Contexto integration.

## 1. Hybrid Knowledge Retrieval with QMD

Contexto leverages the **`@tobilu/qmd`** (Query Markdown) package to transform your local Obsidian vault into a real-time, queryable knowledge base. 

- **Dual Search:** Instead of relying solely on the standard SQLite memory, Contexto concurrently searches both your OpenClaw memory graph and your Markdown vault.
- **CPU Optimized:** The deep neural cross-encoder (reranking) in QMD is disabled (`rerank: false`), allowing the system to execute blazing-fast retrieval on standard local CPUs without requiring a GPU.

## 2. The `before_prompt_build` Hook

The magic happens right before OpenClaw sends a request to the Large Language Model. Contexto integrates deeply into the OpenClaw lifecycle using the **`before_prompt_build`** hook.

When a query is initiated:
1. **Interception:** The `before_prompt_build` hook fires, temporarily pausing the standard OpenClaw execution.
2. **Concurrent Fetching:** The system uses `Promise.allSettled()` to fetch relevant contexts from both the SQLite memory store and the QMD markdown index simultaneously. 
3. **Robustness:** Using `allSettled()` ensures that even if one service fails (e.g., an LLM API key error or a database timeout), the agent won't crash. It will gracefully degrade and still inject whatever context successfully loaded.
4. **Injection:** The retrieved snippets are concatenated and injected into the prompt context before finally being shipped to the LLM.

## 3. Real-Time Syncing (Watcher)

To ensure the agent always has access to your latest thoughts, Contexto implements a background file watcher. 

- **Live Tracking:** It listens to the configured `knowledgeFolder` (your Obsidian vault).
- **Auto-Embedding:** Any changes, additions, or modifications to your markdown files trigger a debounced update. The system automatically recompiles and embeds the new information into the QMD index, keeping the knowledge base perpetually fresh.
