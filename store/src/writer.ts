import { appendFile, mkdir } from 'node:fs/promises';
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
  /** Per-file promise chains — serializes writes to the same session file. */
  private chains = new Map<string, Promise<void>>();

  constructor(private dataDir: string) {}

  /**
   * Append an event to the session JSONL file.
   *
   * Writes are serialized per session file (deterministic line order) but
   * concurrent across different sessions. Fire-and-forget callers may lose
   * events on hard crash — acceptable for an observability layer. Use flush()
   * for clean shutdown paths.
   */
  async append(input: AppendInput): Promise<void> {
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

    // Store raw IDs for traceability (sanitizeId always appends a hash suffix)
    if (input.agentId) {
      storeEvent.rawAgentId = input.agentId;
    }
    if (input.sessionId) {
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
    const filePath = join(dir, `${sanitizedSessionId}.jsonl`);

    // Chain writes to the same file — different files write concurrently
    const prev = this.chains.get(filePath) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.writeLine(dir, filePath, line));
    this.chains.set(filePath, next);

    // Prune completed chain entry to avoid unbounded map growth
    next.then(() => { if (this.chains.get(filePath) === next) this.chains.delete(filePath); })
        .catch(() => { if (this.chains.get(filePath) === next) this.chains.delete(filePath); });

    return next;
  }

  /** Await all pending writes — use for clean shutdown. */
  async flush(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private async writeLine(dir: string, filePath: string, line: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, line + '\n');
  }
}
