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

export interface LocalBackendConfig {
  provider: 'openrouter' | 'openai';
  apiKey: string;
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
