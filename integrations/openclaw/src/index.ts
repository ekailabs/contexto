import { appendFile, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

// --- Constants ---

const SCHEMA_VERSION = 1;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX_ENTRIES = 500;
const DEDUP_HOLD_MS = 30;

const REDACTED_KEYS = new Set([
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

type RouteKind = 'conversation' | 'system' | 'orphan';

type RouteResult = {
  conversationKey: string;
  routeKind: RouteKind;
  routeReason: string;
};

type AppendInput = {
  id?: string;
  ts?: number;
  hook: string;
  event: unknown;
  ctx?: Record<string, unknown>;
  conversationKey?: string;
  routeKind?: RouteKind;
  routeReason?: string;
  userId?: string;
  _dedupeApplied?: boolean;
};

// --- Utility functions ---

function shortHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 8);
}

function sanitizeId(raw: string): string {
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const hash = shortHash(raw);
  return `${sanitized}-${hash}`;
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function safeReplacer() {
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

function safeStringify(obj: unknown): string {
  return JSON.stringify(obj, safeReplacer());
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function toolParamsFingerprint(event: any): string | undefined {
  const name = event?.toolName ?? event?.name;
  const params = event?.params ?? event?.arguments ?? event?.input;
  if (!name) return undefined;
  const paramsStr = params ? safeStringify(params) : '';
  return `${name}:${sha256(paramsStr)}`;
}

function toolDedupFingerprint(conversationKey: string, event: any): string | undefined {
  const name = event?.toolName ?? event?.name;
  const params = event?.params ?? event?.arguments ?? event?.input;
  const result = event?.result ?? event?.output;
  if (!name) return undefined;
  const combined = safeStringify({ params, result });
  return `${conversationKey}:${name}:${sha256(combined)}`;
}

// --- CorrelationCache ---

type CacheEntry = { conversationKey: string; insertedAt: number };

class CorrelationCache {
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

type HeldEvent = {
  event: any;
  ctx: any;
  route: RouteResult;
  userId?: string;
  fingerprint: string;
  arrivedAt: number;
  timer: ReturnType<typeof setTimeout>;
};

class ToolCallTracker {
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

// --- EventWriter (conversation-first routing) ---

class EventWriter {
  private chains = new Map<string, Promise<void>>();

  constructor(private dataDir: string) {}

  async append(input: AppendInput): Promise<void> {
    const id = input.id ?? randomUUID();
    const eventTs = input.ts ?? Date.now();
    const ingestTs = Date.now();

    const storeEvent: Record<string, unknown> = {
      id,
      v: SCHEMA_VERSION,
      eventTs,
      ingestTs,
      hook: input.hook,
      conversationKey: input.conversationKey,
      routeKind: input.routeKind,
      routeReason: input.routeReason,
      userId: input.userId,
      event: input.event,
      ctx: input.ctx,
    };

    if (input._dedupeApplied) {
      storeEvent._dedupeApplied = true;
    }

    let line: string;
    try {
      line = safeStringify(storeEvent);
    } catch {
      line = JSON.stringify({
        id,
        v: SCHEMA_VERSION,
        eventTs,
        ingestTs,
        hook: input.hook,
        conversationKey: input.conversationKey,
        routeKind: input.routeKind,
        event: {},
        _error: 'serialization failed',
      });
    }

    const { dir, filePath } = this.resolvePath(input.routeKind ?? 'orphan', input.conversationKey ?? 'unknown');

    const prev = this.chains.get(filePath) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.writeLine(dir, filePath, line));
    this.chains.set(filePath, next);

    next
      .then(() => {
        if (this.chains.get(filePath) === next) this.chains.delete(filePath);
      })
      .catch(() => {
        if (this.chains.get(filePath) === next) this.chains.delete(filePath);
      });

    return next;
  }

  async flush(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private resolvePath(routeKind: RouteKind, conversationKey: string): { dir: string; filePath: string } {
    const date = todayDate();
    switch (routeKind) {
      case 'conversation': {
        const dir = join(this.dataDir, 'conversations');
        const filePath = join(dir, `${sanitizeId(conversationKey)}.jsonl`);
        return { dir, filePath };
      }
      case 'system': {
        const dir = join(this.dataDir, 'system');
        const filePath = join(dir, `system-${date}.jsonl`);
        return { dir, filePath };
      }
      case 'orphan': {
        const dir = join(this.dataDir, 'orphans');
        const filePath = join(dir, `orphan-${date}.jsonl`);
        return { dir, filePath };
      }
    }
  }

  private async writeLine(dir: string, filePath: string, line: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, line + '\n');
  }
}

// --- resolveConversationKey ---

function resolveConversationKey(event: any, ctx: any, cache: CorrelationCache): RouteResult {
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

// --- Plugin definition ---

const SYSTEM_HOOKS = new Set(['gateway_start', 'gateway_stop']);

export default {
  id: 'claw-contexto',
  name: 'Ekai Contexto',
  description: 'Context engine for OpenClaw — captures lifecycle events for memory and analytics',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dataDir: { type: 'string' },
    },
  },

  register(api: any) {
    const dataDir = api.resolvePath(api.pluginConfig?.dataDir ?? '~/.openclaw/ekai/data');
    const store = new EventWriter(dataDir);
    const cache = new CorrelationCache();

    // --- Emit helper: writes a single event to the store ---

    function emit(event: any, ctx: any, route: RouteResult, userId?: string, deduped?: boolean) {
      void store.append({
        hook: ctx?._hookName ?? 'unknown',
        event: event ?? {},
        ctx: ctx ? { ...ctx } : undefined,
        conversationKey: route.conversationKey,
        routeKind: route.routeKind,
        routeReason: route.routeReason,
        userId,
        _dedupeApplied: deduped,
      }).catch((err) => api.logger.warn(`claw-contexto: ${ctx?._hookName ?? 'unknown'}: ${String(err)}`));
    }

    const toolDedup = new ToolCallTracker(emit);

    // --- Unified observe helper ---

    function observe(hookName: string, event: any, ctx: any, overrideKind?: 'system') {
      const userId = event?.from ?? ctx?.userId ?? undefined;
      const ctxWithHook = ctx ? { ...ctx, _hookName: hookName } : { _hookName: hookName };

      if (overrideKind === 'system') {
        const route: RouteResult = {
          conversationKey: `system-${todayDate()}`,
          routeKind: 'system',
          routeReason: 'system-hook',
        };
        emit(event, ctxWithHook, route, userId);
        return;
      }

      const route = resolveConversationKey(event, ctx, cache);

      if (hookName === 'before_tool_call') {
        const fp = toolParamsFingerprint(event);
        if (fp && route.routeKind === 'conversation') {
          cache.seedToolCall(fp, route.conversationKey);
        }
      }

      if (hookName === 'after_tool_call') {
        // If orphan, try tool-call fingerprint one more time
        if (route.routeKind === 'orphan') {
          const fp = toolParamsFingerprint(event);
          if (fp) {
            const cached = cache.lookupToolCall(fp);
            if (cached) {
              route.conversationKey = cached;
              route.routeKind = 'conversation';
              route.routeReason = 'toolCall-cached-afterRetry';
            }
          }
        }
        toolDedup.receive(event, ctxWithHook, route, userId);
        return;
      }

      emit(event, ctxWithHook, route, userId);
    }

    // --- Session hooks ---
    api.on('session_start', (event: any, ctx: any) => { observe('session_start', event, ctx); });
    api.on('session_end', (event: any, ctx: any) => { observe('session_end', event, ctx); });

    // --- Message hooks ---
    api.on('message_received', (event: any, ctx: any) => { observe('message_received', event, ctx); });
    api.on('message_sending', (event: any, ctx: any) => { observe('message_sending', event, ctx); });
    api.on('message_sent', (event: any, ctx: any) => { observe('message_sent', event, ctx); });

    // --- Agent hooks ---
    api.on('llm_input', (event: any, ctx: any) => { observe('llm_input', event, ctx); });
    api.on('llm_output', (event: any, ctx: any) => { observe('llm_output', event, ctx); });
    api.on('before_compaction', (event: any, ctx: any) => { observe('before_compaction', event, ctx); });
    api.on('after_compaction', (event: any, ctx: any) => { observe('after_compaction', event, ctx); });
    api.on('before_reset', (event: any, ctx: any) => { observe('before_reset', event, ctx); });

    // Agent (modifying, return void — observe only)
    api.on('before_model_resolve', (event: any, ctx: any) => { observe('before_model_resolve', event, ctx); });
    api.on('before_prompt_build', (event: any, ctx: any) => { observe('before_prompt_build', event, ctx); });
    api.on('before_agent_start', (event: any, ctx: any) => { observe('before_agent_start', event, ctx); });

    // Tool hooks
    api.on('before_tool_call', (event: any, ctx: any) => { observe('before_tool_call', event, ctx); });
    api.on('after_tool_call', (event: any, ctx: any) => { observe('after_tool_call', event, ctx); });

    // --- Sync hooks ---
    api.on('tool_result_persist', (event: any, ctx: any) => { observe('tool_result_persist', event, ctx); });
    api.on('before_message_write', (event: any, ctx: any) => { observe('before_message_write', event, ctx); });

    // --- Subagent hooks ---
    api.on('subagent_spawning', (event: any, ctx: any) => { observe('subagent_spawning', event, ctx); });
    api.on('subagent_delivery_target', (event: any, ctx: any) => { observe('subagent_delivery_target', event, ctx); });
    api.on('subagent_spawned', (event: any, ctx: any) => { observe('subagent_spawned', event, ctx); });
    api.on('subagent_ended', (event: any, ctx: any) => { observe('subagent_ended', event, ctx); });

    // --- Gateway hooks (system stream) ---
    api.on('gateway_start', (event: any, ctx: any) => { observe('gateway_start', event, ctx, 'system'); });

    // --- Flush hooks (async — await write + flush before shutdown) ---

    api.on('agent_end', async (event: any, ctx: any) => {
      try {
        const userId = event?.from ?? ctx?.userId ?? undefined;
        const ctxWithHook = ctx ? { ...ctx, _hookName: 'agent_end' } : { _hookName: 'agent_end' };
        const route = resolveConversationKey(event, ctx, cache);
        await store.append({
          hook: 'agent_end',
          event: event ?? {},
          ctx: ctxWithHook,
          conversationKey: route.conversationKey,
          routeKind: route.routeKind,
          routeReason: route.routeReason,
          userId,
        });
        toolDedup.flush();
        await store.flush();
      } catch (err) {
        api.logger.warn(`claw-contexto: agent_end: ${String(err)}`);
      }
    });

    api.on('gateway_stop', async (event: any, ctx: any) => {
      try {
        const route: RouteResult = {
          conversationKey: `system-${todayDate()}`,
          routeKind: 'system',
          routeReason: 'system-hook',
        };
        await store.append({
          hook: 'gateway_stop',
          event: event ?? {},
          ctx: ctx ? { ...ctx, _hookName: 'gateway_stop' } : { _hookName: 'gateway_stop' },
          conversationKey: route.conversationKey,
          routeKind: route.routeKind,
          routeReason: route.routeReason,
        });
        toolDedup.flush();
        await store.flush();
      } catch (err) {
        api.logger.warn(`claw-contexto: gateway_stop: ${String(err)}`);
      }
    });

    api.logger.info(`claw-contexto: storing events to ${dataDir}`);
  },
};
