// Ported from ekailabs-api-server/src/types/summary.ts
// Simplified: production's episode.{userMessage,assistantMessages,toolMessages}
// is replaced with a flat `turn` shape appropriate for a single trajectory turn.

export type EvidenceRefType = 'episode_ref' | 'tool_ref' | 'file_ref' | 'trace_ref';

export interface EvidenceRef {
  type: EvidenceRefType;
  value: string;
}

export interface TurnData {
  episodeId: string;
  turnIndex: number;
  role: string;
  rawContent: string;
}

export interface EpisodeSummaryMetadata {
  status: 'complete' | 'partial' | 'blocked';
  evidence_refs: EvidenceRef[];
  open_questions?: string[];
  confidence?: number;
  trace_ref: string;
  turn: TurnData;
}

export interface EpisodeSummary {
  id: string;
  summary: string;
  key_findings: string[];
  metadata: EpisodeSummaryMetadata;
  timestamp: string;
}

export interface ValidationResult {
  valid: boolean;
  failures: string[];
}
