import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockAdd, mockGetAgents, mockAddAgent, mockAgent } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockGetAgents: vi.fn(),
  mockAddAgent: vi.fn(),
  mockAgent: vi.fn(),
}));

vi.mock('@ekai/memory', () => ({
  Memory: vi.fn().mockImplementation(() => ({
    getAgents: mockGetAgents,
    addAgent: mockAddAgent,
    agent: mockAgent,
  })),
}));

import { runBootstrap, type BootstrapProgress } from '../src/bootstrap';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `claw-bootstrap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSession(stateDir: string, agentId: string, filename: string, messages: any[]) {
  const sessionsDir = join(stateDir, 'agents', agentId, 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const lines = messages.map((m) => JSON.stringify(m));
  writeFileSync(join(sessionsDir, filename), lines.join('\n'), 'utf-8');
}

function createMem() {
  return { agent: mockAgent } as any;
}

function createLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

describe('runBootstrap', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    mockAdd.mockResolvedValue({ stored: 1, ids: ['m1'] });
    mockAgent.mockReturnValue({ add: mockAdd });
    mockGetAgents.mockReturnValue([]);
    mockAddAgent.mockImplementation((id: string, opts?: any) => ({ id, name: opts?.name }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ingests sessions and marks done', async () => {
    writeSession(tmpDir, 'bot1', 'sess1.jsonl', [
      { type: 'message', message: { role: 'user', content: 'hello' } },
      { type: 'message', message: { role: 'assistant', content: 'hi' } },
    ]);

    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const ensureAgent = vi.fn();

    const result = await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger: createLogger(),
      ensureAgent,
      delayMs: 0,
    });

    expect(result.sessionsProcessed).toBe(1);
    expect(progress.__bootstrap?.status).toBe('done');
    expect(progress['bot1:sess1']).toBe(2);
    expect(mockAdd).toHaveBeenCalledOnce();
    expect(mockAdd).toHaveBeenCalledWith([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]);
    expect(ensureAgent).toHaveBeenCalledWith('bot1');
  });

  it('handles cross-agent collision (same session filename)', async () => {
    writeSession(tmpDir, 'agentA', 'shared.jsonl', [
      { type: 'message', message: { role: 'user', content: 'from A' } },
    ]);
    writeSession(tmpDir, 'agentB', 'shared.jsonl', [
      { type: 'message', message: { role: 'user', content: 'from B' } },
    ]);

    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const ensureAgent = vi.fn();

    const result = await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger: createLogger(),
      ensureAgent,
      delayMs: 0,
    });

    expect(result.sessionsProcessed).toBe(2);
    expect(progress['agentA:shared']).toBe(1);
    expect(progress['agentB:shared']).toBe(1);
    expect(mockAdd).toHaveBeenCalledTimes(2);
  });

  it('is idempotent — second call returns 0', async () => {
    writeSession(tmpDir, 'bot1', 'sess1.jsonl', [
      { type: 'message', message: { role: 'user', content: 'hello' } },
    ]);

    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const ensureAgent = vi.fn();
    const opts = { stateDir: tmpDir, mem: createMem(), progress, saveProgress, logger: createLogger(), ensureAgent, delayMs: 0 };

    await runBootstrap(opts);
    mockAdd.mockClear();

    const result = await runBootstrap(opts);
    expect(result.sessionsProcessed).toBe(0);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('resumes — skips already-processed sessions', async () => {
    writeSession(tmpDir, 'bot1', 'done.jsonl', [
      { type: 'message', message: { role: 'user', content: 'old' } },
    ]);
    writeSession(tmpDir, 'bot1', 'new.jsonl', [
      { type: 'message', message: { role: 'user', content: 'fresh' } },
    ]);

    const progress: BootstrapProgress = {
      __bootstrap: { status: 'running', startedAt: Date.now() - 5000 },
      'bot1:done': 1,
    };
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const ensureAgent = vi.fn();

    const result = await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger: createLogger(),
      ensureAgent,
      delayMs: 0,
    });

    expect(result.sessionsProcessed).toBe(1);
    expect(progress['bot1:new']).toBe(1);
    expect(mockAdd).toHaveBeenCalledOnce();
    expect(mockAdd).toHaveBeenCalledWith([{ role: 'user', content: 'fresh' }]);
  });

  it('ignores empty and whitespace-only lines', async () => {
    const sessionsDir = join(tmpDir, 'agents', 'bot1', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const content = [
      '',
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'real' } }),
      '   ',
      '',
    ].join('\n');
    writeFileSync(join(sessionsDir, 'sess.jsonl'), content, 'utf-8');

    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const logger = createLogger();

    await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger,
      ensureAgent: vi.fn(),
      delayMs: 0,
    });

    expect(logger.warn).not.toHaveBeenCalled();
    expect(mockAdd).toHaveBeenCalledWith([{ role: 'user', content: 'real' }]);
  });

  it('warns and skips malformed JSON lines', async () => {
    const sessionsDir = join(tmpDir, 'agents', 'bot1', 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    const content = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'good' } }),
      'NOT JSON {{{',
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: 'also good' } }),
    ].join('\n');
    writeFileSync(join(sessionsDir, 'sess.jsonl'), content, 'utf-8');

    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);
    const logger = createLogger();

    await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger,
      ensureAgent: vi.fn(),
      delayMs: 0,
    });

    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('line 2'));
    expect(mockAdd).toHaveBeenCalledWith([
      { role: 'user', content: 'good' },
      { role: 'assistant', content: 'also good' },
    ]);
  });

  it('handles missing agents/ directory', async () => {
    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);

    const result = await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger: createLogger(),
      ensureAgent: vi.fn(),
      delayMs: 0,
    });

    expect(result.sessionsProcessed).toBe(0);
    expect(progress.__bootstrap?.status).toBe('done');
  });

  it('handles agent dir with no sessions/ subdirectory', async () => {
    mkdirSync(join(tmpDir, 'agents', 'bot1'), { recursive: true });
    // No sessions/ dir inside

    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);

    const result = await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger: createLogger(),
      ensureAgent: vi.fn(),
      delayMs: 0,
    });

    expect(result.sessionsProcessed).toBe(0);
    expect(progress.__bootstrap?.status).toBe('done');
  });

  it('skips .reset. files', async () => {
    writeSession(tmpDir, 'bot1', 'normal.jsonl', [
      { type: 'message', message: { role: 'user', content: 'yes' } },
    ]);
    writeSession(tmpDir, 'bot1', 'some.reset.jsonl', [
      { type: 'message', message: { role: 'user', content: 'no' } },
    ]);

    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);

    await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger: createLogger(),
      ensureAgent: vi.fn(),
      delayMs: 0,
    });

    expect(mockAdd).toHaveBeenCalledOnce();
    expect(progress['bot1:normal']).toBe(1);
    expect(progress['bot1:some.reset.jsonl']).toBeUndefined();
  });

  it('sets done even with no sessions to ingest', async () => {
    mkdirSync(join(tmpDir, 'agents', 'bot1', 'sessions'), { recursive: true });
    // Empty sessions dir

    const progress: BootstrapProgress = {};
    const saveProgress = vi.fn().mockResolvedValue(undefined);

    const result = await runBootstrap({
      stateDir: tmpDir,
      mem: createMem(),
      progress,
      saveProgress,
      logger: createLogger(),
      ensureAgent: vi.fn(),
      delayMs: 0,
    });

    expect(result.sessionsProcessed).toBe(0);
    expect(progress.__bootstrap?.status).toBe('done');
    expect(progress.__bootstrap?.completedAt).toBeTypeOf('number');
  });
});
