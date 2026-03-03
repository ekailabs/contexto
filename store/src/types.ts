import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 1;

// --- Store Event (what gets written to JSONL) ---

export interface StoreEvent {
  id: string;
  v: number;
  eventTs: number;
  ingestTs: number;
  hook: string;
  sessionId: string;
  agentId: string;
  rawSessionId?: string;
  rawAgentId?: string;
  conversationId?: string;
  userId?: string;
  event: Record<string, any>;
  ctx?: Record<string, any>;
}

// --- Append Input (what callers pass in) ---

export interface AppendInput {
  id?: string;
  ts?: number;
  hook: string;
  sessionId?: string;
  agentId?: string;
  conversationId?: string;
  userId?: string;
  event: Record<string, any>;
  ctx?: Record<string, any>;
}

// --- Reconstructed Types ---

export interface ReconstructedSession {
  sessionId: string;
  agentId: string;
  startedAt: number;
  endedAt?: number;
  turns: ReconstructedTurn[];
}

export interface ReconstructedTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content?: string;
  model?: string;
  userId?: string;
  userAttribution: 'explicit' | 'inferred' | 'unknown';
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: ReconstructedToolCall[];
  toolCallId?: string;
  timestamp: number;
}

export interface ReconstructedToolCall {
  id: string;
  toolName: string;
  arguments: Record<string, any>;
  result?: any;
  error?: string;
  status: 'success' | 'error' | 'pending';
  durationMs?: number;
}

// --- ID Sanitization ---

const UNKNOWN_AGENT = '_unknown-agent';
const UNKNOWN_SESSION = '_unknown-session';

function shortHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

/**
 * Sanitize an ID for use in file paths.
 * Result: `{sanitized}-{shortHash}` where sanitized = raw reduced to [a-zA-Z0-9_-],
 * other chars replaced with _, truncated to 64 chars. shortHash = first 8 hex chars of SHA-256.
 */
export function sanitizeId(raw: string | undefined | null, fallback: 'agent' | 'session'): string {
  if (!raw || raw.trim() === '') {
    return fallback === 'agent' ? UNKNOWN_AGENT : UNKNOWN_SESSION;
  }
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const hash = shortHash(raw);
  return `${sanitized}-${hash}`;
}
