import type { WebhookPayload } from '../types.js';

export interface CompactionState {
  bufferedMessages: WebhookPayload[];
  lastSessionId: string;
  lastSessionKey: string;
  cachedTokenBudget: number | undefined;
  injectedItemIds: Set<string>;
}

export function createCompactionState(): CompactionState {
  return {
    bufferedMessages: [],
    lastSessionId: '',
    lastSessionKey: '',
    cachedTokenBudget: undefined,
    injectedItemIds: new Set(),
  };
}

export interface BootstrapParams {
  sessionId: string;
  sessionFile: string;
  sessionKey?: string;
}

export interface BootstrapResult {
  bootstrapped: boolean;
  importedMessages: number;
  reason: string;
}

export interface IngestParams {
  sessionId: string;
  sessionKey?: string;
  message: any;
  isHeartbeat?: boolean;
}

export interface IngestBatchParams {
  sessionId: string;
  sessionKey?: string;
  messages: any[];
  isHeartbeat?: boolean;
}

export interface AfterTurnParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  messages: any[];
  prePromptMessageCount: number;
  isHeartbeat?: boolean;
  runtimeContext?: Record<string, unknown>;
}

export interface AssembleParams {
  sessionId: string;
  sessionKey?: string;
  messages: any[];
  tokenBudget?: number;
  prompt?: string;
}

export interface AssembleResult {
  messages: any[];
  estimatedTokens: number;
}

export interface CompactParams {
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  tokenBudget?: number;
  currentTokenCount?: number;
  compactionTarget?: 'budget' | 'threshold';
  customInstructions?: string;
  runtimeContext?: Record<string, unknown>;
  legacyParams?: Record<string, unknown>;
  force?: boolean;
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason: string;
  result?: {
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
  };
}

export interface SubagentSpawnParams {
  parentSessionKey: string;
  childSessionKey: string;
  ttlMs?: number;
}

export interface SubagentEndedParams {
  childSessionKey: string;
  reason: string;
}
