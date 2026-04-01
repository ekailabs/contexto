export interface ConversationItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  embedding: number[];
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

export interface ClusterNode {
  id: string;
  label: string;
  centroid: number[];
  children: ClusterNode[];
  items: ConversationItem[];
  depth: number;
  itemCount: number;
}

export interface MindmapConfig {
  similarityThreshold: number;
  maxDepth: number;
  maxChildren: number;
  rebuildInterval: number;
}

export interface MindmapState {
  root: ClusterNode;
  config: MindmapConfig;
  stats: {
    totalItems: number;
    totalClusters: number;
    insertsSinceRebuild: number;
  };
}

export interface QueryResult {
  items: ConversationItem[];
  path: string[];
}

export interface TreeNode {
  label: string;
  children: TreeNode[];
  items?: { id: string; role: string; content: string; timestamp?: string }[];
  depth?: number;
  itemCount?: number;
}

export type EmbedFn = (text: string) => Promise<number[]>;

export interface LLMConfig {
  provider: 'openrouter' | 'openai';
  apiKey: string;
  model?: string;
}

export interface ScoredItem {
  item: ConversationItem;
  score: number;
  estimatedTokens: number;
}

export interface ScoredQueryResult {
  items: ScoredItem[];
  paths: string[][];
  totalCandidates: number;
  totalEstimatedTokens: number;
}

export interface SearchOptions {
  maxResults?: number;
  maxTokens?: number;
  beamWidth?: number;
}

export const DEFAULT_CONFIG: MindmapConfig = {
  similarityThreshold: 0.65,
  maxDepth: 4,
  maxChildren: 10,
  rebuildInterval: 50,
};
