import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Safe JSON replacer — handles circular refs, BigInt, undefined, errors.
 * No external deps needed.
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

function safeStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj, safeReplacer());
  } catch {
    return JSON.stringify({ _error: 'serialization failed' });
  }
}

/**
 * Extract sessionId and agentId from event or ctx (whichever has them).
 */
function extractIds(event: any, ctx: any): { sessionId?: string; agentId?: string } {
  return {
    sessionId: event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey ?? undefined,
    agentId: event?.agentId ?? ctx?.agentId ?? undefined,
  };
}

export class EventLog {
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  /**
   * Append a hook event to the JSONL log.
   * Uses appendFileSync for tool_result_persist sync compatibility.
   *
   * NOTE (v0): appendFileSync blocks the event loop. Acceptable at low volume.
   * Future: async write with buffering for high-throughput hooks.
   */
  append(hook: string, event: unknown, ctx: unknown): void {
    const { sessionId, agentId } = extractIds(event, ctx);
    const line = safeStringify({ ts: Date.now(), hook, sessionId, agentId, event, ctx });
    appendFileSync(this.path, line + '\n');
  }
}
