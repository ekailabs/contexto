import type { ContextEngine } from 'openclaw/plugin-sdk';
import type { WebhookPayload } from '../types.js';

// Derive param types from the ContextEngine interface
type MethodParams<M extends keyof ContextEngine> =
  ContextEngine[M] extends ((...args: infer P) => any) | undefined
    ? P[0]
    : never;

export type BootstrapParams = MethodParams<'bootstrap'>;
export type IngestParams = MethodParams<'ingest'>;
export type IngestBatchParams = MethodParams<'ingestBatch'>;
export type AfterTurnParams = MethodParams<'afterTurn'>;
export type AssembleParams = MethodParams<'assemble'>;
export type CompactParams = MethodParams<'compact'>;
export type SubagentSpawnParams = MethodParams<'prepareSubagentSpawn'>;
export type SubagentEndedParams = MethodParams<'onSubagentEnded'>;

/** Large context pending RLM processing. */
export interface PendingContext {
  content: string;
  tokenEstimate: number;
}

// Internal state — not part of the SDK contract
export interface CompactionState {
  bufferedMessages: WebhookPayload[];
  lastSessionId: string;
  lastSessionKey: string;
  cachedTokenBudget: number | undefined;
  injectedItemIds: Set<string>;
  /** Large contexts awaiting RLM subagent processing, keyed by sessionKey. */
  pendingLargeContext: Map<string, PendingContext>;
  /** Active RLM subagent sessions, keyed by childSessionKey → parentSessionKey. */
  activeRlmSessions: Map<string, string>;
}

export function createCompactionState(): CompactionState {
  return {
    bufferedMessages: [],
    lastSessionId: '',
    lastSessionKey: '',
    cachedTokenBudget: undefined,
    injectedItemIds: new Set(),
    pendingLargeContext: new Map(),
    activeRlmSessions: new Map(),
  };
}
