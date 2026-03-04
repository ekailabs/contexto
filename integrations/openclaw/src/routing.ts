import { createHash } from 'node:crypto';

// --- Constants ---

export const SCHEMA_VERSION = 1;
export const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
export const CACHE_MAX_ENTRIES = 500;
export const DEDUP_HOLD_MS = 30;

export const REDACTED_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'authorization',
  'cookie',
  'password',
  'secret',
  'access_token',
  'refresh_token',
  'x-api-key',
  'set-cookie',
]);

// --- Types ---

export type RouteKind = 'conversation' | 'system' | 'orphan';

export type RouteResult = {
  conversationKey: string;
  routeKind: RouteKind;
  routeReason: string;
};

export type CacheEntry = { conversationKey: string; insertedAt: number };

export type HeldEvent = {
  event: any;
  ctx: any;
  route: RouteResult;
  userId?: string;
  fingerprint: string;
  arrivedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export type AppendInput = {
  id?: string;
  ts?: number;
  hook: string;
  event: unknown;
  ctx?: Record<string, unknown>;
  conversationKey?: string;
  routeKind?: RouteKind;
  routeReason?: string;
  userId?: string;
  _dedupTracked?: boolean;
};

// --- Utility functions ---

export function shortHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

export function sanitizeId(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const hash = shortHash(raw);
  return `${sanitized}-${hash}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function safeReplacer() {
  const seen = new WeakSet<object>();
  return (key: string, value: unknown): unknown => {
    if (typeof key === 'string' && REDACTED_KEYS.has(key.toLowerCase())) {
      return '[REDACTED]';
    }
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Error) return { message: value.message, stack: value.stack };
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

export function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, safeReplacer());
}

export function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toolParamsFingerprint(event: any): string | undefined {
  const name = event?.toolName ?? event?.name;
  const params = event?.params ?? event?.arguments ?? event?.input;
  if (!name) return undefined;
  const paramsStr = params ? safeStringify(params) : '';
  return `${name}:${sha256(paramsStr)}`;
}

export function toolDedupFingerprint(conversationKey: string, event: any): string | undefined {
  const name = event?.toolName ?? event?.name;
  const params = event?.params ?? event?.arguments ?? event?.input;
  const result = event?.result ?? event?.output;
  if (!name) return undefined;
  const combined = safeStringify({ params, result });
  return `${conversationKey}:${name}:${sha256(combined)}`;
}

// --- CorrelationCache ---

export class CorrelationCache {
  private map = new Map<string, CacheEntry>();

  get(key: string): string | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.insertedAt > CACHE_TTL_MS) {
      this.map.delete(key);
      return undefined;
    }
    return entry.conversationKey;
  }

  set(key: string, conversationKey: string): void {
    if (this.map.size >= CACHE_MAX_ENTRIES) {
      this.evictOldest();
    }
    this.map.set(key, { conversationKey, insertedAt: Date.now() });
  }

  seed(conversationKey: string, ctx: any): void {
    if (ctx?.sessionKey) this.set(`sk:${ctx.sessionKey}`, conversationKey);
    if (ctx?.sessionId) this.set(`si:${ctx.sessionId}`, conversationKey);
    if (ctx?.agentId && ctx?.sessionId) {
      this.set(`as:${ctx.agentId}:${ctx.sessionId}`, conversationKey);
    }
  }

  seedToolCall(fingerprint: string, conversationKey: string): void {
    this.set(`tc:${fingerprint}`, conversationKey);
  }

  lookupToolCall(fingerprint: string): string | undefined {
    return this.get(`tc:${fingerprint}`);
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTime = Infinity;
    for (const [k, v] of this.map) {
      if (v.insertedAt < oldestTime) {
        oldestTime = v.insertedAt;
        oldestKey = k;
      }
    }
    if (oldestKey) this.map.delete(oldestKey);
  }
}

// --- ToolCallTracker (dedup for after_tool_call) ---

export class ToolCallTracker {
  private held = new Map<string, HeldEvent>();
  private emitFn: (event: any, ctx: any, route: RouteResult, userId?: string, deduped?: boolean) => void;

  constructor(emitFn: (event: any, ctx: any, route: RouteResult, userId?: string, deduped?: boolean) => void) {
    this.emitFn = emitFn;
  }

  receive(event: any, ctx: any, route: RouteResult, userId?: string): void {
    const fp = toolDedupFingerprint(route.conversationKey, event);
    if (!fp) {
      this.emitFn(event, ctx, route, userId);
      return;
    }

    const existing = this.held.get(fp);
    if (existing && Date.now() - existing.arrivedAt <= DEDUP_HOLD_MS) {
      // Duplicate within window — keep the richer variant
      const existingHasDuration = existing.event?.durationMs != null;
      const newHasDuration = event?.durationMs != null;
      if (newHasDuration && !existingHasDuration) {
        clearTimeout(existing.timer);
        const timer = setTimeout(() => this.emitHeld(fp), DEDUP_HOLD_MS);
        this.held.set(fp, { event, ctx, route, userId, fingerprint: fp, arrivedAt: existing.arrivedAt, timer });
      }
      // else keep existing (it's already richer or equal)
      return;
    }

    // New event or outside window
    if (existing) {
      clearTimeout(existing.timer);
      this.emitHeld(fp);
    }

    const timer = setTimeout(() => this.emitHeld(fp), DEDUP_HOLD_MS);
    this.held.set(fp, { event, ctx, route, userId, fingerprint: fp, arrivedAt: Date.now(), timer });
  }

  flush(): void {
    for (const [fp, held] of this.held) {
      clearTimeout(held.timer);
      this.emitFn(held.event, held.ctx, held.route, held.userId, true);
    }
    this.held.clear();
  }

  private emitHeld(fp: string): void {
    const held = this.held.get(fp);
    if (!held) return;
    this.held.delete(fp);
    this.emitFn(held.event, held.ctx, held.route, held.userId, true);
  }
}

// --- resolveConversationKey ---

export function resolveConversationKey(event: any, ctx: any, cache: CorrelationCache): RouteResult {
  // 1. conversationId — strongest signal
  if (ctx?.conversationId) {
    const key = String(ctx.conversationId);
    cache.seed(key, ctx);
    return { conversationKey: key, routeKind: 'conversation', routeReason: 'conversationId' };
  }

  // 2. sessionKey — cache lookup, then use directly
  if (ctx?.sessionKey) {
    const cached = cache.get(`sk:${ctx.sessionKey}`);
    if (cached) return { conversationKey: cached, routeKind: 'conversation', routeReason: 'sessionKey-cached' };
    const key = String(ctx.sessionKey);
    cache.seed(key, ctx);
    return { conversationKey: key, routeKind: 'conversation', routeReason: 'sessionKey' };
  }

  // 3. sessionId — cache lookup, then use directly
  if (ctx?.sessionId) {
    const cached = cache.get(`si:${ctx.sessionId}`);
    if (cached) return { conversationKey: cached, routeKind: 'conversation', routeReason: 'sessionId-cached' };
    // If agentId present too, try composite key
    if (ctx?.agentId) {
      const asCached = cache.get(`as:${ctx.agentId}:${ctx.sessionId}`);
      if (asCached) return { conversationKey: asCached, routeKind: 'conversation', routeReason: 'agentId+sessionId-cached' };
    }
    const key = String(ctx.sessionId);
    cache.seed(key, ctx);
    return { conversationKey: key, routeKind: 'conversation', routeReason: 'sessionId' };
  }

  // 4. Subagent keys
  if (ctx?.childSessionKey) {
    const cached = cache.get(`sk:${ctx.childSessionKey}`);
    if (cached) return { conversationKey: cached, routeKind: 'conversation', routeReason: 'childSessionKey-cached' };
  }
  if (ctx?.requesterSessionKey) {
    const cached = cache.get(`sk:${ctx.requesterSessionKey}`);
    if (cached) return { conversationKey: cached, routeKind: 'conversation', routeReason: 'requesterSessionKey-cached' };
  }

  // 5. Tool-call correlation fingerprint (params-only)
  const fp = toolParamsFingerprint(event);
  if (fp) {
    const cached = cache.lookupToolCall(fp);
    if (cached) return { conversationKey: cached, routeKind: 'conversation', routeReason: 'toolCall-cached' };
  }

  // 6. No match — orphan
  return { conversationKey: `orphan-${todayDate()}`, routeKind: 'orphan', routeReason: 'no-correlation' };
}
