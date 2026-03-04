import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  DEDUP_HOLD_MS,
  CorrelationCache,
  ToolCallTracker,
  resolveConversationKey,
  toolParamsFingerprint,
  toolDedupFingerprint,
  type RouteResult,
} from '../src/routing';

// ---------------------------------------------------------------------------
// CorrelationCache
// ---------------------------------------------------------------------------

describe('CorrelationCache', () => {
  let cache: CorrelationCache;

  beforeEach(() => {
    cache = new CorrelationCache();
  });

  it('get/set round-trip', () => {
    cache.set('k1', 'conv-1');
    expect(cache.get('k1')).toBe('conv-1');
  });

  it('returns undefined for missing key', () => {
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after CACHE_TTL_MS', () => {
    vi.useFakeTimers();
    try {
      cache.set('k1', 'conv-1');
      vi.advanceTimersByTime(CACHE_TTL_MS + 1);
      expect(cache.get('k1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts oldest entry when at capacity', () => {
    vi.useFakeTimers();
    try {
      for (let i = 0; i < CACHE_MAX_ENTRIES; i++) {
        cache.set(`key-${i}`, `conv-${i}`);
        vi.advanceTimersByTime(1); // ensure distinct insertedAt
      }
      // Cache is full — inserting one more should evict key-0 (oldest)
      cache.set('overflow', 'conv-overflow');
      expect(cache.get('key-0')).toBeUndefined();
      expect(cache.get('overflow')).toBe('conv-overflow');
      // key-1 should still exist
      expect(cache.get('key-1')).toBe('conv-1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('seed() populates sk:/si:/as: keys', () => {
    const ctx = { sessionKey: 'sk1', sessionId: 'si1', agentId: 'a1' };
    cache.seed('conv-x', ctx);
    expect(cache.get('sk:sk1')).toBe('conv-x');
    expect(cache.get('si:si1')).toBe('conv-x');
    expect(cache.get('as:a1:si1')).toBe('conv-x');
  });

  it('seedToolCall/lookupToolCall round-trip', () => {
    cache.seedToolCall('fp-1', 'conv-t');
    expect(cache.lookupToolCall('fp-1')).toBe('conv-t');
    expect(cache.lookupToolCall('fp-missing')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ToolCallTracker
// ---------------------------------------------------------------------------

describe('ToolCallTracker', () => {
  let emitted: Array<{ event: any; ctx: any; route: RouteResult; userId?: string; deduped?: boolean }>;
  let tracker: ToolCallTracker;

  beforeEach(() => {
    vi.useFakeTimers();
    emitted = [];
    tracker = new ToolCallTracker((event, ctx, route, userId, deduped) => {
      emitted.push({ event, ctx, route, userId, deduped });
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const route: RouteResult = { conversationKey: 'conv-1', routeKind: 'conversation', routeReason: 'test' };

  it('emits immediately when event has no fingerprint (no tool name)', () => {
    tracker.receive({ data: 1 }, { _hookName: 'h' }, route, 'u1');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].deduped).toBeUndefined();
  });

  it('holds event for DEDUP_HOLD_MS, then emits with deduped=true', () => {
    const event = { toolName: 'search', params: { q: 'a' }, result: 'ok' };
    tracker.receive(event, {}, route, 'u1');
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(DEDUP_HOLD_MS);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].deduped).toBe(true);
    expect(emitted[0].event).toBe(event);
  });

  it('keeps richer variant (has durationMs) within dedup window', () => {
    const basic = { toolName: 'search', params: { q: 'a' }, result: 'ok' };
    const rich = { toolName: 'search', params: { q: 'a' }, result: 'ok', durationMs: 42 };

    tracker.receive(basic, {}, route, 'u1');
    tracker.receive(rich, {}, route, 'u1');
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(DEDUP_HOLD_MS);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].event).toBe(rich);
  });

  it('drops exact duplicate within dedup window', () => {
    const event = { toolName: 'search', params: { q: 'a' }, result: 'ok' };

    tracker.receive(event, {}, route, 'u1');
    tracker.receive({ ...event }, {}, route, 'u1'); // same fingerprint, no durationMs
    expect(emitted).toHaveLength(0);

    vi.advanceTimersByTime(DEDUP_HOLD_MS);
    expect(emitted).toHaveLength(1);
  });

  it('emits held + starts new hold when same fingerprint arrives after window', () => {
    const event = { toolName: 'search', params: { q: 'a' }, result: 'ok' };

    tracker.receive(event, { n: 1 }, route, 'u1');
    vi.advanceTimersByTime(DEDUP_HOLD_MS + 1); // first emitted
    expect(emitted).toHaveLength(1);

    tracker.receive(event, { n: 2 }, route, 'u1');
    vi.advanceTimersByTime(DEDUP_HOLD_MS);
    expect(emitted).toHaveLength(2);
    expect(emitted[1].ctx).toEqual({ n: 2 });
  });

  it('flush() emits all held events and clears', () => {
    const e1 = { toolName: 'a', params: {}, result: '1' };
    const e2 = { toolName: 'b', params: {}, result: '2' };
    tracker.receive(e1, {}, route, 'u1');
    tracker.receive(e2, {}, route, 'u1');
    expect(emitted).toHaveLength(0);

    tracker.flush();
    expect(emitted).toHaveLength(2);
    expect(emitted.every((e) => e.deduped === true)).toBe(true);

    // Timers should be cancelled — advancing shouldn't double-emit
    vi.advanceTimersByTime(DEDUP_HOLD_MS * 10);
    expect(emitted).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// resolveConversationKey
// ---------------------------------------------------------------------------

describe('resolveConversationKey', () => {
  let cache: CorrelationCache;

  beforeEach(() => {
    cache = new CorrelationCache();
  });

  it('priority 1: conversationId → direct + seeds cache', () => {
    const ctx = { conversationId: 'c1', sessionKey: 'sk1', sessionId: 'si1' };
    const result = resolveConversationKey({}, ctx, cache);
    expect(result).toEqual({ conversationKey: 'c1', routeKind: 'conversation', routeReason: 'conversationId' });
    // Should have seeded cache
    expect(cache.get('sk:sk1')).toBe('c1');
    expect(cache.get('si:si1')).toBe('c1');
  });

  it('priority 2: sessionKey → cache hit', () => {
    cache.set('sk:sk1', 'conv-from-cache');
    const result = resolveConversationKey({}, { sessionKey: 'sk1' }, cache);
    expect(result.conversationKey).toBe('conv-from-cache');
    expect(result.routeReason).toBe('sessionKey-cached');
  });

  it('priority 2: sessionKey → direct when no cache', () => {
    const result = resolveConversationKey({}, { sessionKey: 'sk2' }, cache);
    expect(result.conversationKey).toBe('sk2');
    expect(result.routeReason).toBe('sessionKey');
  });

  it('priority 3: sessionId → cache hit', () => {
    cache.set('si:si1', 'conv-si');
    const result = resolveConversationKey({}, { sessionId: 'si1' }, cache);
    expect(result.conversationKey).toBe('conv-si');
    expect(result.routeReason).toBe('sessionId-cached');
  });

  it('priority 3: sessionId + agentId → composite cache hit', () => {
    cache.set('as:a1:si1', 'conv-as');
    const result = resolveConversationKey({}, { sessionId: 'si1', agentId: 'a1' }, cache);
    expect(result.conversationKey).toBe('conv-as');
    expect(result.routeReason).toBe('agentId+sessionId-cached');
  });

  it('priority 3: sessionId → direct when no cache', () => {
    const result = resolveConversationKey({}, { sessionId: 'si2' }, cache);
    expect(result.conversationKey).toBe('si2');
    expect(result.routeReason).toBe('sessionId');
  });

  it('priority 4: childSessionKey → cache-only', () => {
    cache.set('sk:child1', 'conv-child');
    const result = resolveConversationKey({}, { childSessionKey: 'child1' }, cache);
    expect(result.conversationKey).toBe('conv-child');
    expect(result.routeReason).toBe('childSessionKey-cached');
  });

  it('priority 4: requesterSessionKey → cache-only', () => {
    cache.set('sk:req1', 'conv-req');
    const result = resolveConversationKey({}, { requesterSessionKey: 'req1' }, cache);
    expect(result.conversationKey).toBe('conv-req');
    expect(result.routeReason).toBe('requesterSessionKey-cached');
  });

  it('priority 5: toolCall fingerprint → cache-only', () => {
    const event = { toolName: 'search', params: { q: 'hello' } };
    const fp = toolParamsFingerprint(event)!;
    cache.seedToolCall(fp, 'conv-tool');
    const result = resolveConversationKey(event, {}, cache);
    expect(result.conversationKey).toBe('conv-tool');
    expect(result.routeReason).toBe('toolCall-cached');
  });

  it('priority 6: orphan fallback when nothing matches', () => {
    const result = resolveConversationKey({}, {}, cache);
    expect(result.routeKind).toBe('orphan');
    expect(result.routeReason).toBe('no-correlation');
    expect(result.conversationKey).toMatch(/^orphan-\d{4}-\d{2}-\d{2}$/);
  });
});

// ---------------------------------------------------------------------------
// toolParamsFingerprint / toolDedupFingerprint
// ---------------------------------------------------------------------------

describe('toolParamsFingerprint', () => {
  it('returns name:hash for valid event', () => {
    const fp = toolParamsFingerprint({ toolName: 'search', params: { q: 'hello' } });
    expect(fp).toMatch(/^search:[0-9a-f]{64}$/);
  });

  it('returns undefined when no tool name', () => {
    expect(toolParamsFingerprint({ params: { q: 'hello' } })).toBeUndefined();
    expect(toolParamsFingerprint({})).toBeUndefined();
    expect(toolParamsFingerprint(null)).toBeUndefined();
  });

  it('produces different fingerprints for different inputs', () => {
    const fp1 = toolParamsFingerprint({ toolName: 'search', params: { q: 'a' } });
    const fp2 = toolParamsFingerprint({ toolName: 'search', params: { q: 'b' } });
    expect(fp1).not.toBe(fp2);
  });

  it('uses name field as fallback for toolName', () => {
    const fp = toolParamsFingerprint({ name: 'search', arguments: { q: 'hello' } });
    expect(fp).toMatch(/^search:[0-9a-f]{64}$/);
  });
});

describe('toolDedupFingerprint', () => {
  it('returns conversationKey:name:hash for valid event', () => {
    const fp = toolDedupFingerprint('conv-1', { toolName: 'search', params: { q: 'a' }, result: 'ok' });
    expect(fp).toMatch(/^conv-1:search:[0-9a-f]{64}$/);
  });

  it('returns undefined when no tool name', () => {
    expect(toolDedupFingerprint('conv-1', {})).toBeUndefined();
  });

  it('produces different fingerprints for different results', () => {
    const fp1 = toolDedupFingerprint('conv-1', { toolName: 'x', params: {}, result: 'a' });
    const fp2 = toolDedupFingerprint('conv-1', { toolName: 'x', params: {}, result: 'b' });
    expect(fp1).not.toBe(fp2);
  });
});
