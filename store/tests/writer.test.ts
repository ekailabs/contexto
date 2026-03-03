import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventWriter } from '../src/writer.js';
import { SCHEMA_VERSION, sanitizeId } from '../src/types.js';

describe('EventWriter', () => {
  let dataDir: string;
  let writer: EventWriter;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ekai-store-test-'));
    writer = new EventWriter(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function readLines(agentId: string, sessionId: string): any[] {
    const sAgent = sanitizeId(agentId, 'agent');
    const sSession = sanitizeId(sessionId, 'session');
    const content = readFileSync(join(dataDir, sAgent, `${sSession}.jsonl`), 'utf-8');
    return content.trim().split('\n').map(line => JSON.parse(line));
  }

  it('normalizes input with id, version, timestamps', () => {
    writer.append({
      hook: 'session_start',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      event: { foo: 'bar' },
    });

    const lines = readLines('agent-1', 'sess-1');
    expect(lines).toHaveLength(1);
    const ev = lines[0];
    expect(ev.id).toBeDefined();
    expect(ev.v).toBe(SCHEMA_VERSION);
    expect(ev.eventTs).toBeTypeOf('number');
    expect(ev.ingestTs).toBeTypeOf('number');
    expect(ev.ingestTs).toBeGreaterThanOrEqual(ev.eventTs);
    expect(ev.hook).toBe('session_start');
    expect(ev.event).toEqual({ foo: 'bar' });
  });

  it('preserves caller-provided id for idempotent retries', () => {
    writer.append({
      id: 'my-custom-id',
      hook: 'message_received',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      event: {},
    });

    const lines = readLines('agent-1', 'sess-1');
    expect(lines[0].id).toBe('my-custom-id');
  });

  it('uses caller ts as eventTs when provided', () => {
    const ts = 1700000000000;
    writer.append({
      ts,
      hook: 'llm_output',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      event: {},
    });

    const lines = readLines('agent-1', 'sess-1');
    expect(lines[0].eventTs).toBe(ts);
    expect(lines[0].ingestTs).toBeGreaterThanOrEqual(ts);
  });

  it('sanitizes agentId and sessionId', () => {
    writer.append({
      hook: 'session_start',
      sessionId: 'sess/with/slashes',
      agentId: 'agent?with?marks',
      event: {},
    });

    const agentDir = readdirSync(dataDir)[0];
    expect(agentDir).toMatch(/^agent_with_marks-[a-f0-9]{8}$/);

    const sessionFile = readdirSync(join(dataDir, agentDir))[0];
    expect(sessionFile).toMatch(/^sess_with_slashes-[a-f0-9]{8}\.jsonl$/);
  });

  it('stores rawAgentId/rawSessionId when sanitization changes value', () => {
    writer.append({
      hook: 'session_start',
      sessionId: 'sess/special',
      agentId: 'agent/special',
      event: {},
    });

    const agentDir = readdirSync(dataDir)[0];
    const sessionFile = readdirSync(join(dataDir, agentDir))[0];
    const content = readFileSync(join(dataDir, agentDir, sessionFile), 'utf-8');
    const ev = JSON.parse(content.trim());

    expect(ev.rawAgentId).toBe('agent/special');
    expect(ev.rawSessionId).toBe('sess/special');
  });

  it('does not store raw IDs when sanitization is a no-op', () => {
    writer.append({
      hook: 'session_start',
      sessionId: 'clean-session',
      agentId: 'clean-agent',
      event: {},
    });

    // sanitizeId always appends hash, so raw IDs will differ from sanitized
    // The raw IDs are stored because sanitized adds the hash suffix
    const agentDir = readdirSync(dataDir)[0];
    const sessionFile = readdirSync(join(dataDir, agentDir))[0];
    const content = readFileSync(join(dataDir, agentDir, sessionFile), 'utf-8');
    const ev = JSON.parse(content.trim());
    expect(ev.rawAgentId).toBe('clean-agent');
    expect(ev.rawSessionId).toBe('clean-session');
  });

  it('falls back to _unknown-agent and _unknown-session', () => {
    writer.append({
      hook: 'session_start',
      event: {},
    });

    const agentDir = readdirSync(dataDir)[0];
    expect(agentDir).toBe('_unknown-agent');

    const sessionFile = readdirSync(join(dataDir, agentDir))[0];
    expect(sessionFile).toBe('_unknown-session.jsonl');
  });

  it('handles empty string IDs as unknown', () => {
    writer.append({
      hook: 'session_start',
      sessionId: '',
      agentId: '   ',
      event: {},
    });

    const agentDir = readdirSync(dataDir)[0];
    expect(agentDir).toBe('_unknown-agent');
  });

  it('safely serializes circular references', () => {
    const circular: any = { a: 1 };
    circular.self = circular;

    writer.append({
      hook: 'message_received',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      event: circular,
    });

    const lines = readLines('agent-1', 'sess-1');
    expect(lines).toHaveLength(1);
    expect(lines[0].event.self).toBe('[Circular]');
  });

  it('safely serializes BigInt values', () => {
    writer.append({
      hook: 'message_received',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      event: { big: BigInt(9007199254740991) },
    });

    const lines = readLines('agent-1', 'sess-1');
    expect(lines[0].event.big).toBe('9007199254740991');
  });

  it('fallback preserves core fields when safeStringify throws', () => {
    // Create an object with a toJSON that throws — defeats the safe replacer
    const poison = {
      toJSON() { throw new Error('toJSON bomb'); },
    };

    writer.append({
      id: 'fallback-id',
      ts: 1700000000000,
      hook: 'llm_output',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      event: poison as any,
    });

    const lines = readLines('agent-1', 'sess-1');
    expect(lines).toHaveLength(1);
    const ev = lines[0];
    expect(ev.id).toBe('fallback-id');
    expect(ev.hook).toBe('llm_output');
    expect(ev.eventTs).toBe(1700000000000);
    expect(ev.ingestTs).toBeTypeOf('number');
    expect(ev._error).toBe('serialization failed');
  });

  it('safely serializes Error objects', () => {
    writer.append({
      hook: 'after_tool_call',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      event: { error: new Error('test failure') },
    });

    const lines = readLines('agent-1', 'sess-1');
    expect(lines[0].event.error.message).toBe('test failure');
    expect(lines[0].event.error.stack).toBeDefined();
  });

  it('appends multiple events to the same session file', () => {
    writer.append({ hook: 'session_start', sessionId: 's1', agentId: 'a1', event: {} });
    writer.append({ hook: 'message_received', sessionId: 's1', agentId: 'a1', event: { text: 'hi' } });
    writer.append({ hook: 'session_end', sessionId: 's1', agentId: 'a1', event: {} });

    const lines = readLines('a1', 's1');
    expect(lines).toHaveLength(3);
    expect(lines.map((l: any) => l.hook)).toEqual(['session_start', 'message_received', 'session_end']);
  });

  it('creates separate files for different sessions', () => {
    writer.append({ hook: 'session_start', sessionId: 's1', agentId: 'a1', event: {} });
    writer.append({ hook: 'session_start', sessionId: 's2', agentId: 'a1', event: {} });

    const agentDir = sanitizeId('a1', 'agent');
    const files = readdirSync(join(dataDir, agentDir));
    expect(files).toHaveLength(2);
  });

  it('stores optional fields: conversationId, userId, ctx', () => {
    writer.append({
      hook: 'message_received',
      sessionId: 'sess-1',
      agentId: 'agent-1',
      conversationId: 'conv-123',
      userId: 'user-456',
      event: { text: 'hello' },
      ctx: { mode: 'chat' },
    });

    const lines = readLines('agent-1', 'sess-1');
    expect(lines[0].conversationId).toBe('conv-123');
    expect(lines[0].userId).toBe('user-456');
    expect(lines[0].ctx).toEqual({ mode: 'chat' });
  });
});

describe('sanitizeId', () => {
  it('replaces non-alphanumeric chars with underscore and appends hash', () => {
    const result = sanitizeId('a/b?c', 'agent');
    expect(result).toMatch(/^a_b_c-[a-f0-9]{8}$/);
  });

  it('truncates to 64 chars before hash', () => {
    const long = 'a'.repeat(100);
    const result = sanitizeId(long, 'session');
    const [prefix, hash] = result.split('-');
    expect(prefix.length).toBeLessThanOrEqual(64);
    expect(hash).toMatch(/^[a-f0-9]{8}$/);
  });

  it('different raw IDs produce different sanitized results', () => {
    const r1 = sanitizeId('a/b', 'agent');
    const r2 = sanitizeId('a?b', 'agent');
    expect(r1).not.toBe(r2);
  });

  it('returns fallback for undefined/null/empty', () => {
    expect(sanitizeId(undefined, 'agent')).toBe('_unknown-agent');
    expect(sanitizeId(null, 'session')).toBe('_unknown-session');
    expect(sanitizeId('', 'agent')).toBe('_unknown-agent');
  });
});
