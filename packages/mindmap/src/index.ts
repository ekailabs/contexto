// High-level API
export { Mindmap, createMindmap } from './mindmap.js';
export type { MindmapOptions } from './mindmap.js';

// Embed providers
export { createEmbedFn } from './embed.js';
export type { EmbedConfig, EmbedProvider } from './embed.js';

// Storage
export { jsonFileStorage, memoryStorage } from './storage.js';
export type { MindmapStorage } from './storage.js';

// Low-level API (for direct use without Mindmap class)
export { buildMindmap, addToMindmap } from './clustering.js';
export { queryMindmap, queryMindmapMultiBranch } from './retrieval.js';
export { extractFromWebhook } from './extractor.js';
export { cosineSimilarity, cosineDistance } from './similarity.js';
export { generateLabel } from './labeler.js';

// Types
export type {
  ConversationItem,
  ClusterNode,
  LLMConfig,
  MindmapConfig,
  MindmapState,
  QueryResult,
  ScoredItem,
  ScoredQueryResult,
  SearchOptions,
  EmbedFn,
  TreeNode,
} from './types.js';

export { DEFAULT_CONFIG } from './types.js';

// Serialization
export function serializeMindmap(state: import('./types.js').MindmapState): string {
  return JSON.stringify(state);
}

export function deserializeMindmap(json: string): import('./types.js').MindmapState {
  return JSON.parse(json);
}

// Visualization-friendly export (strips embeddings/centroids)
export { toTree, toTreeLLM } from './tree.js';
