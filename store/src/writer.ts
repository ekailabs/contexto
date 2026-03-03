import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION, sanitizeId } from './types.js';
import type { AppendInput, StoreEvent } from './types.js';

/**
 * Safe JSON replacer — handles circular refs, BigInt, Error objects.
 */
function safeReplacer() {
  const seen = new WeakSet();
  return (_key: string, value: unknown): unknown => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) return { message: value.message, stack: value.stack };
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

/**
 * Stringify with safe replacer. Throws on total failure so callers can
 * provide a structured fallback with core fields preserved.
 */
function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, safeReplacer());
}

export class EventWriter {
  constructor(private dataDir: string) {}

  append(input: AppendInput): void {
    const id = input.id ?? randomUUID();
    const eventTs = input.ts ?? Date.now();
    const ingestTs = Date.now();

    const sanitizedAgentId = sanitizeId(input.agentId, 'agent');
    const sanitizedSessionId = sanitizeId(input.sessionId, 'session');

    const storeEvent: StoreEvent = {
      id,
      v: SCHEMA_VERSION,
      eventTs,
      ingestTs,
      hook: input.hook,
      sessionId: sanitizedSessionId,
      agentId: sanitizedAgentId,
      conversationId: input.conversationId,
      userId: input.userId,
      event: input.event,
      ctx: input.ctx,
    };

    // Only store raw IDs if sanitization changed the value
    if (input.agentId && sanitizedAgentId !== input.agentId) {
      storeEvent.rawAgentId = input.agentId;
    }
    if (input.sessionId && sanitizedSessionId !== input.sessionId) {
      storeEvent.rawSessionId = input.sessionId;
    }

    let line: string;
    try {
      line = safeStringify(storeEvent);
    } catch {
      // Fallback: core fields only (all primitives — guaranteed serializable)
      line = JSON.stringify({
        id,
        v: SCHEMA_VERSION,
        eventTs,
        ingestTs,
        hook: input.hook,
        sessionId: sanitizedSessionId,
        agentId: sanitizedAgentId,
        event: {},
        _error: 'serialization failed',
      });
    }

    const dir = join(this.dataDir, sanitizedAgentId);
    mkdirSync(dir, { recursive: true });
    const filePath = join(dir, `${sanitizedSessionId}.jsonl`);
    appendFileSync(filePath, line + '\n');
  }
}
