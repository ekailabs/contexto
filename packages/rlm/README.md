# @ekai/rlm

A toolkit for reasoning over large contexts that exceed a language model's practical token budget. Built for LLM agent loops, `@ekai/rlm` provides structured tools that let an agent explore, search, and query over massive inputs — documents, logs, codebases, data exports — without flooding the context window.

Inspired by the [Recursive Language Model](https://arxiv.org/abs/2502.07814) paper, adapted from a monolithic engine into a modular, tools-first architecture that composes naturally with any agent framework.

## Why

Large language models are powerful reasoners, but they have finite context windows. When a user provides a 200-page PDF, a sprawling codebase, or a multi-megabyte log file, the naive approach — stuffing everything into the prompt — either truncates the content, degrades quality, or simply fails.

`@ekai/rlm` solves this by keeping the full content in an efficient in-memory buffer and exposing it through six purpose-built tools. The agent decides what to look at, when, and how deeply — much like a human skimming a document, searching for keywords, and reading sections of interest closely.

The result is bounded token usage regardless of input size, with no loss of reasoning coverage.

## How It Works

The core abstraction is the **ContextBuffer** — an in-memory, line-indexed representation of the input text. Content is loaded once and never passed directly into any LLM prompt. Instead, the agent interacts with it through tools that return small, targeted slices.

A typical agent session flows like this:

1. The agent calls **rlm_overview** to understand the structure — how many lines, what sections exist, a brief preview of the beginning.
2. Based on the overview, it uses **rlm_grep** to locate relevant sections by keyword or pattern.
3. It reads specific regions with **rlm_peek** or **rlm_slice** to examine the content in detail.
4. For questions that require synthesis, it uses **rlm_query** to delegate a focused sub-LLM call over a bounded chunk.
5. For complex multi-step analysis, the agent writes and executes JavaScript in **rlm_repl** — a sandboxed environment with access to all retrieval functions and persistent variables across iterations.

The agent controls the decomposition strategy. Simple questions might need only a grep and a slice. Complex analysis might involve dozens of REPL iterations with intermediate sub-LLM calls. The tools support both.

## Tools

### rlm_overview

Returns a structural summary of the loaded content: total character and line counts, a list of detected sections (identified from markdown headers and page breaks), and a short preview of the opening lines. This is typically the first tool an agent calls to orient itself within a large document.

### rlm_peek

Displays a window of lines starting at a given offset. The default window is 50 lines. This is the primary tool for sequential reading — the agent can page through a document by advancing the offset, similar to scrolling through a file.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `offset` | Yes | Line number to start from (0-indexed) |
| `length` | No | Number of lines to return (default: 50) |

### rlm_grep

Searches the full content for a pattern and returns matching lines along with their surrounding context. Supports both plain substring matching and regular expressions. Results are capped to prevent overwhelming the agent with too many matches.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `pattern` | Yes | Search term or regex pattern |
| `regex` | No | Interpret pattern as a regular expression (default: false) |
| `limit` | No | Maximum number of results (default: 20) |

### rlm_slice

Extracts a contiguous block of lines by range. Unlike peek, which is designed for browsing, slice is intended for targeted extraction — pulling out a specific function, a table, or a section the agent has already located.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `start` | Yes | Start line, inclusive (0-indexed) |
| `end` | Yes | End line, exclusive |

### rlm_query

Sends a question along with a bounded chunk of the context to a sub-LLM call. The agent specifies which portion of the content to include, and the tool handles chunking, prompt construction, and response extraction. This is the primary tool for semantic reasoning over content that the agent has identified as relevant.

The sub-LLM call is made through the injected **CompletionProvider**, keeping the package decoupled from any specific LLM vendor or SDK.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `question` | Yes | The question to answer from the context |
| `start` | No | Start line of the chunk to analyze (default: 0) |
| `end` | No | End line of the chunk (default: full content, up to token budget) |

### rlm_repl

The most powerful tool in the set. It provides a sandboxed JavaScript execution environment (built on Node.js `vm`) with access to the full context, all retrieval functions, and sub-LLM calls. Variables persist across invocations, enabling multi-turn analysis workflows.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `code` | Yes | JavaScript code to execute |

The sandbox exposes the following built-in functions and variables:

- **`context`** — the raw text content as a string
- **`peek(offset, length)`** — same as the rlm_peek tool
- **`grep(pattern, opts)`** — same as rlm_grep
- **`slice(start, end)`** — same as rlm_slice
- **`llm_query(prompt)`** — asynchronous sub-LLM call
- **`store(key, value)` / `get(key)`** — key-value storage that persists across REPL invocations
- **`FINAL(answer)` / `FINAL_VAR(name)`** — declare the final result to return to the agent
- **`len(x)` / `chunk(text, size)`** — utility helpers

The sandbox enforces strict security constraints: 30-second execution timeout, a maximum of 20 iterations per session, and 20,000-character output truncation. Dangerous constructs — `eval`, `Function`, `require`, `import`, `process`, `fetch`, and prototype chain access — are blocked at the code validation level before execution.

## Document Parsing

Raw documents must be converted to plain text before loading into the ContextBuffer. The package includes parsers for common formats:

| Format | MIME Types | Peer Dependency |
|--------|-----------|-----------------|
| PDF | `application/pdf` | `pdf-parse` (optional) |
| Excel | `application/vnd.ms-excel`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `xlsx` (optional) |
| Text | `text/plain`, `text/markdown`, `text/csv`, `application/json` | None (built-in) |

The `parseDocument` function dispatches to the appropriate parser based on MIME type and returns an array of chunks with metadata (page numbers, sheet names, etc.). These chunks are typically concatenated into a single string for the ContextBuffer.

PDF and Excel support require their respective peer dependencies to be installed. If a parser's dependency is missing at runtime, it will throw a clear error explaining what to install.

## CompletionProvider

The `rlm_query` and `rlm_repl` tools need access to an LLM for sub-queries. Rather than bundling provider-specific SDKs, `@ekai/rlm` defines a minimal `CompletionProvider` contract: a `completion` method that accepts a message array and returns a string, and a convenience `completionStr` method for single-prompt calls.

This design keeps the package standalone and provider-agnostic. Any LLM backend — OpenAI, Anthropic, a local model, or a custom gateway — can be used by implementing two functions.

When used within the [Contexto](https://github.com/ekailabs/contexto) plugin, the provider is automatically wired to [pi-ai](https://docs.openclaw.ai/pi), OpenClaw's built-in LLM abstraction.

## Architecture

```
                     ┌─────────────────────────────────────┐
                     │          Large Input                 │
                     │  (PDF, Excel, logs, code, text...)   │
                     └──────────────┬──────────────────────┘
                                    │
                              parseDocument()
                                    │
                                    ▼
                     ┌─────────────────────────────────────┐
                     │         ContextBuffer                │
                     │  In-memory, line-indexed, immutable  │
                     └──────────────┬──────────────────────┘
                                    │
                          Agent selects tools
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                     │
          Exploration          Retrieval             Reasoning
        ┌───────────┐      ┌───────────┐        ┌───────────┐
        │  overview  │     │   grep    │        │   query   │
        │   peek     │     │   slice   │        │   repl    │
        └───────────┘      └───────────┘        └───────────┘
                                                      │
                                                sub-LLM calls
                                              (CompletionProvider)
                                                      │
                                                      ▼
                                             Synthesized Answer
```

The content never enters the agent's context window directly. Token usage stays bounded regardless of input size, while the agent retains full reasoning coverage over the entire document.

## Usage with Contexto

When used as part of the [Contexto](https://github.com/ekailabs/contexto) plugin for [OpenClaw](https://docs.openclaw.ai), RLM can be enabled through the plugin configuration by setting `rlmEnabled` to `true`:

```json
{
  "plugins": {
    "contexto": {
      "apiKey": "your-contexto-api-key",
      "rlmEnabled": true
    }
  }
}
```

When enabled, the plugin automatically registers all six RLM tools with the agent and wires the CompletionProvider to pi-ai via OpenRouter's auto-routing. When disabled (the default), the plugin operates normally without RLM — no tools are registered and no additional dependencies are loaded.

Once enabled, RLM activates automatically when a user message exceeds 50% of the configured token budget. The large content is offloaded to a ContextBuffer, the original message is replaced with a brief instruction telling the agent to use the RLM tools, and the agent proceeds to explore and reason over the content iteratively. After the agent finishes, the synthesized result is ingested into the mindmap for future recall.

RLM can also be invoked explicitly by the user regardless of message size.

## Installation

```bash
npm install @ekai/rlm
```

For document parsing support:

```bash
npm install pdf-parse    # optional — enables PDF parsing
npm install xlsx         # optional — enables Excel parsing
```

## License

[Apache-2.0](../../LICENSE)
