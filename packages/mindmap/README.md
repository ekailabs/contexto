# @ekai/mindmap

Semantic clustering mindmap for AI agent context management. Organizes conversation items into a hierarchical tree using embeddings and retrieves relevant context via beam search.

## Install

```bash
npm install @ekai/mindmap
```

## Quick Start

```typescript
import { createMindmap } from '@ekai/mindmap';

const mindmap = createMindmap({
  provider: 'openrouter',
  apiKey: process.env.OPENROUTER_API_KEY!,
});

// Add conversation items
await mindmap.add([
  { id: '1', role: 'user', content: 'How do I set up authentication?' },
  { id: '2', role: 'assistant', content: 'You can use JWT or OAuth2...' },
  { id: '3', role: 'user', content: 'What database should I use?' },
  { id: '4', role: 'assistant', content: 'PostgreSQL is a solid choice...' },
]);

// Simple query (single-branch, returns ConversationItem[])
const result = await mindmap.query('auth setup');

// Multi-branch search with token budgeting (for agent context windows)
const scored = await mindmap.search('authentication and database setup', {
  maxResults: 20,
  maxTokens: 4000,
  beamWidth: 3,
});
// scored.items — ScoredItem[] with { item, score, estimatedTokens }
// scored.paths — cluster label paths explored
// scored.totalEstimatedTokens — total tokens of returned items
```

## Retrieval

### `query(text, maxResults?)`

Greedy single-branch traversal. Follows the best-matching cluster at each tree level and returns the top items by cosine similarity. Fast, but may miss items in other clusters.

### `search(text, options?)`

Multi-branch beam search. Explores the top `beamWidth` clusters at each level, collects items from all matching branches, and applies `maxResults` and `maxTokens` caps. Returns items with similarity scores and token estimates — designed for fitting relevant context into an agent's context window.

## Embedding Providers

Pass a built-in provider or a custom embedding function:

```typescript
// Built-in providers: 'openrouter', 'openai', 'gemini'
const mindmap = createMindmap({
  provider: 'openrouter',
  apiKey: '...',
  embedModel: 'openai/text-embedding-3-small', // optional
});

// Custom embedding function
const mindmap = createMindmap({
  embedFn: async (text) => myEmbedder.embed(text),
});
```

## Storage

```typescript
import { createMindmap, jsonFileStorage, memoryStorage } from '@ekai/mindmap';

// In-memory (default)
const mindmap = createMindmap({ provider: 'openrouter', apiKey: '...' });

// Persist to JSON file
const mindmap = createMindmap({
  provider: 'openrouter',
  apiKey: '...',
  storage: jsonFileStorage('./mindmap.json'),
});
```

## Configuration

```typescript
const mindmap = createMindmap({
  provider: 'openrouter',
  apiKey: '...',
  config: {
    similarityThreshold: 0.65, // min cosine similarity to follow a branch
    maxDepth: 4,               // max tree depth
    maxChildren: 10,           // max children per node
    rebuildInterval: 50,       // inserts before full tree rebuild
  },
});
```

## License

MIT
