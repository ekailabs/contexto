import type { MindmapStorage } from '@ekai/mindmap';
import type { MindmapConfig } from '@ekai/mindmap';

export type EvidenceRefType = 'episode_ref' | 'tool_ref' | 'file_ref' | 'trace_ref';

export interface EvidenceRef {
  type: EvidenceRefType;
  value: string;
}

export interface EpisodeSummary {
  summary: string;
  key_findings: string[];
  status: 'complete' | 'partial' | 'blocked';
  confidence: number;
  evidence_refs: EvidenceRef[];
  open_questions?: string[];
}

export interface ResolvedCredentials {
  provider: 'openrouter' | 'openai';
  apiKey: string;
}

export interface LocalBackendConfig {
  /**
   * Resolved credentials, or a function that resolves them lazily on first use.
   * Lazy resolution lets the plugin call registerContextEngine synchronously
   * during register() while deferring async API-key lookup to first ingest/search.
   */
  credentials: ResolvedCredentials | (() => Promise<ResolvedCredentials | null>);
  embedModel?: string;
  llmModel?: string;
  storage?: MindmapStorage;
  mindmapConfig?: Partial<MindmapConfig>;
}

export interface LLMProviderConfig {
  provider: 'openrouter' | 'openai';
  apiKey: string;
  model?: string;
}
