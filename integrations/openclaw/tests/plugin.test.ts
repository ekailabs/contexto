import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- Hoisted mocks for @ekai/memory ---

const { mockAdd, mockSearch, mockGetAgents, mockAddAgent, mockAgent } = vi.hoisted(() => ({
  mockAdd: vi.fn(),
  mockSearch: vi.fn(),
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

import plugin, {
  extractText,
  normalizeMessages,
  redact,
  lastUserMessage,
  loadProgress,
  resolveMemoryProvider,
} from '../src/index';

import { Memory } from '@ekai/memory';

// --- extractText ---

describe('extractText', () => {
  it('passes through plain strings', () => {
    expect(extractText('hello')).toBe('hello');
  });

  it('joins structured text chunks', () => {
    const chunks = [
      { type: 'text', text: 'line 1' },
      { type: 'text', text: 'line 2' },
    ];
    expect(extractText(chunks)).toBe('line 1\nline 2');
  });

  it('filters non-text chunks', () => {
    const chunks = [
      { type: 'image', url: 'http://example.com' },
      { type: 'text', text: 'only this' },
    ];
    expect(extractText(chunks)).toBe('only this');
  });

  it('handles object with text field', () => {
    expect(extractText({ text: 'from obj' })).toBe('from obj');
  });

  it('returns empty for junk input', () => {
    expect(extractText(42)).toBe('');
    expect(extractText(null)).toBe('');
    expect(extractText(undefined)).toBe('');
  });
});

// --- normalizeMessages ---

describe('normalizeMessages', () => {
  it('keeps user and assistant messages', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    expect(normalizeMessages(msgs)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('drops system, tool, and toolResult roles', () => {
    const msgs = [
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
      { role: 'tool', content: 'tool output' },
      { role: 'toolResult', content: 'result' },
      { role: 'assistant', content: 'ok' },
    ];
    expect(normalizeMessages(msgs)).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok' },
    ]);
  });

  it('handles structured content', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'text', text: 'structured' }] },
    ];
    expect(normalizeMessages(msgs)).toEqual([
      { role: 'user', content: 'structured' },
    ]);
  });

  it('filters messages with empty content', () => {
    const msgs = [
      { role: 'user', content: '' },
      { role: 'user', content: '  ' },
      { role: 'assistant', content: 'real' },
    ];
    expect(normalizeMessages(msgs)).toEqual([
      { role: 'assistant', content: 'real' },
    ]);
  });
});

// --- lastUserMessage ---

describe('lastUserMessage', () => {
  it('finds the last user turn', () => {
    const msgs = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ];
    expect(lastUserMessage(msgs)).toBe('second');
  });

  it('skips non-user roles at the end', () => {
    const msgs = [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
    ];
    expect(lastUserMessage(msgs)).toBe('question');
  });

  it('returns undefined for empty messages', () => {
    expect(lastUserMessage([])).toBeUndefined();
  });

  it('skips user messages with empty content', () => {
    const msgs = [
      { role: 'user', content: 'real' },
      { role: 'user', content: '   ' },
    ];
    expect(lastUserMessage(msgs)).toBe('real');
  });
});

// --- redact ---

describe('redact', () => {
  it('strips Bearer tokens', () => {
    expect(redact('Authorization: Bearer eyJhbGciOi.stuff.here')).toBe(
      'Authorization: [REDACTED]',
    );
  });

  it('strips sk-* API keys', () => {
    expect(redact('key is sk-abcdefghij0123456789extra')).toBe(
      'key is [REDACTED]',
    );
  });

  it('strips GitHub tokens', () => {
    expect(redact('token ghp_' + 'a'.repeat(36))).toBe('token [REDACTED]');
  });

  it('preserves normal text', () => {
    const text = 'Hello world, this is a normal sentence.';
    expect(redact(text)).toBe(text);
  });
});

// --- Delta tracking (persisted) ---

describe('delta tracking', () => {
  let tmpDir: string;
  let progressPath: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `claw-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    progressPath = join(tmpDir, 'progress.json');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loadProgress returns empty object for missing file', () => {
    expect(loadProgress(join(tmpDir, 'nonexistent.json'))).toEqual({});
  });

  it('loadProgress reads existing progress', () => {
    const data = { 'session-1': 5, 'session-2': 10 };
    writeFileSync(progressPath, JSON.stringify(data), 'utf-8');
    expect(loadProgress(progressPath)).toEqual(data);
  });

  it('progress survives simulated restart', () => {
    const progress: Record<string, number> = {};
    progress['sess-a'] = 3;
    writeFileSync(progressPath, JSON.stringify(progress), 'utf-8');

    const reloaded = loadProgress(progressPath);
    expect(reloaded['sess-a']).toBe(3);

    reloaded['sess-a'] = 7;
    writeFileSync(progressPath, JSON.stringify(reloaded), 'utf-8');

    const final = loadProgress(progressPath);
    expect(final['sess-a']).toBe(7);
  });
});

// --- Hook behavior + shared helpers ---

function createApi(tmpDir: string) {
  const handlers: Record<string, Function> = {};
  const commands: Record<string, any> = {};
  return {
    resolvePath: () => join(tmpDir, 'memory.db'),
    pluginConfig: {} as any,
    on: vi.fn((hook: string, handler: Function) => { handlers[hook] = handler; }),
    registerCommand: vi.fn((cmd: any) => { commands[cmd.name] = cmd; }),
    logger: { info: vi.fn(), warn: vi.fn() },
    _trigger: async (hook: string, ...args: any[]) => handlers[hook]?.(...args),
    _command: (name: string) => commands[name],
  };
}

// --- resolveMemoryProvider ---

describe('resolveMemoryProvider', () => {
  const logger = { info: vi.fn(), warn: vi.fn() };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('returns explicit config when both provider and apiKey set', () => {
    vi.stubEnv('OPENAI_API_KEY', 'env-key');
    const result = resolveMemoryProvider({ provider: 'gemini', apiKey: 'explicit' }, logger);
    expect(result).toEqual({ provider: 'gemini', apiKey: 'explicit', source: 'config' });
  });

  it('auto-detects openai from env when no config', () => {
    vi.stubEnv('OPENAI_API_KEY', 'oai-key');
    const result = resolveMemoryProvider({}, logger);
    expect(result).toEqual({ provider: 'openai', apiKey: 'oai-key', source: 'env' });
  });

  it('auto-detects gemini when only GOOGLE_API_KEY set', () => {
    const result = resolveMemoryProvider({}, logger);
    // no env keys → undefined
    expect(result).toBeUndefined();

    vi.stubEnv('GOOGLE_API_KEY', 'goog-key');
    const result2 = resolveMemoryProvider({}, logger);
    expect(result2).toEqual({ provider: 'gemini', apiKey: 'goog-key', source: 'env' });
  });

  it('resolves key from env when only provider configured', () => {
    vi.stubEnv('OPENAI_API_KEY', 'oai-key');
    const result = resolveMemoryProvider({ provider: 'openai' }, logger);
    expect(result).toEqual({ provider: 'openai', apiKey: 'oai-key', source: 'config+env' });
  });

  it('warns when provider configured but env key missing', () => {
    const result = resolveMemoryProvider({ provider: 'openai' }, logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("provider 'openai' configured but OPENAI_API_KEY not set"),
    );
  });

  it('warns and ignores apiKey without provider', () => {
    const result = resolveMemoryProvider({ apiKey: 'orphan-key' }, logger);
    expect(result).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('apiKey configured without provider'),
    );
  });

  it('defers to core when MEMORY_EMBED_PROVIDER is set', () => {
    vi.stubEnv('MEMORY_EMBED_PROVIDER', 'openai');
    vi.stubEnv('OPENAI_API_KEY', 'oai-key');
    const result = resolveMemoryProvider({}, logger);
    expect(result).toBeUndefined();
  });

  it('defers to core when MEMORY_EXTRACT_PROVIDER is set', () => {
    vi.stubEnv('MEMORY_EXTRACT_PROVIDER', 'gemini');
    vi.stubEnv('GOOGLE_API_KEY', 'goog-key');
    const result = resolveMemoryProvider({}, logger);
    expect(result).toBeUndefined();
  });
});

describe('plugin.register provider logging', () => {
  let tmpDir: string;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('logs provider and source when auto-detected', () => {
    vi.stubEnv('OPENAI_API_KEY', 'oai-key');
    tmpDir = join(tmpdir(), `claw-prov-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mockGetAgents.mockReturnValue([]);
    mockAddAgent.mockImplementation((id: string, opts?: any) => ({ id, name: opts?.name }));
    mockAgent.mockReturnValue({ add: mockAdd, search: mockSearch });

    const api = createApi(tmpDir);
    plugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('(openai via env)'),
    );
  });

  it('logs provider and source from explicit config', () => {
    tmpDir = join(tmpdir(), `claw-prov-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mockGetAgents.mockReturnValue([]);
    mockAddAgent.mockImplementation((id: string, opts?: any) => ({ id, name: opts?.name }));
    mockAgent.mockReturnValue({ add: mockAdd, search: mockSearch });

    const api = createApi(tmpDir);
    api.pluginConfig = { provider: 'gemini', apiKey: 'gk' };
    plugin.register(api);

    expect(api.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('(gemini via config)'),
    );
  });

  it('passes resolved provider/apiKey to Memory constructor', () => {
    vi.stubEnv('OPENAI_API_KEY', 'oai-key');
    tmpDir = join(tmpdir(), `claw-prov-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mockGetAgents.mockReturnValue([]);
    mockAddAgent.mockImplementation((id: string, opts?: any) => ({ id, name: opts?.name }));
    mockAgent.mockReturnValue({ add: mockAdd, search: mockSearch });

    const api = createApi(tmpDir);
    plugin.register(api);

    expect(Memory).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'openai', apiKey: 'oai-key' }),
    );
  });

  it('omits provider/apiKey from Memory when nothing resolved', () => {
    tmpDir = join(tmpdir(), `claw-prov-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    mockGetAgents.mockReturnValue([]);
    mockAddAgent.mockImplementation((id: string, opts?: any) => ({ id, name: opts?.name }));
    mockAgent.mockReturnValue({ add: mockAdd, search: mockSearch });

    const api = createApi(tmpDir);
    plugin.register(api);

    const callArg = (Memory as any).mock.calls.at(-1)?.[0];
    expect(callArg).not.toHaveProperty('provider');
    expect(callArg).not.toHaveProperty('apiKey');
  });
});

describe('plugin.register', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `claw-reg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
    mkdirSync(tmpDir, { recursive: true });
    mockGetAgents.mockReturnValue([]);
    mockAddAgent.mockImplementation((id: string, opts?: any) => ({ id, name: opts?.name }));
    mockAdd.mockResolvedValue({ stored: 1, ids: ['m1'] });
    mockSearch.mockResolvedValue([]);
    mockAgent.mockReturnValue({ add: mockAdd, search: mockSearch });
  });

  afterEach(() => {
    vi.clearAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates parent directory for dbPath', () => {
    const nested = join(tmpDir, 'deep', 'nested');
    const api = createApi(tmpDir);
    api.resolvePath = () => join(nested, 'memory.db');
    plugin.register(api);
    expect(existsSync(nested)).toBe(true);
  });

  it('seeds knownAgents from existing DB agents', () => {
    mockGetAgents.mockReturnValue([{ id: 'analytics' }, { id: 'main' }]);
    const api = createApi(tmpDir);
    plugin.register(api);
    // addAgent should NOT be called for 'main' since it exists in DB
    expect(mockAddAgent).not.toHaveBeenCalled();
  });

  it('creates main agent when not in DB', () => {
    mockGetAgents.mockReturnValue([]);
    const api = createApi(tmpDir);
    plugin.register(api);
    expect(mockAddAgent).toHaveBeenCalledWith('main', { name: 'main' });
  });

  describe('agent_end hook', () => {
    it('ingests all messages on first call', async () => {
      const api = createApi(tmpDir);
      plugin.register(api);

      await api._trigger('agent_end', {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
      }, { sessionId: 'sess-1' });

      expect(mockAdd).toHaveBeenCalledOnce();
      expect(mockAdd).toHaveBeenCalledWith(
        [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
        ],
        { userId: undefined },
      );
    });

    it('ingests only delta on subsequent call', async () => {
      const api = createApi(tmpDir);
      plugin.register(api);

      // First call: 2 messages
      await api._trigger('agent_end', {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
        ],
      }, { sessionId: 'sess-1' });

      mockAdd.mockClear();

      // Second call: 4 messages (2 new)
      await api._trigger('agent_end', {
        messages: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
          { role: 'user', content: 'second' },
          { role: 'assistant', content: 'reply 2' },
        ],
      }, { sessionId: 'sess-1' });

      expect(mockAdd).toHaveBeenCalledOnce();
      expect(mockAdd).toHaveBeenCalledWith(
        [
          { role: 'user', content: 'second' },
          { role: 'assistant', content: 'reply 2' },
        ],
        { userId: undefined },
      );
    });

    it('skips when message count unchanged', async () => {
      const api = createApi(tmpDir);
      plugin.register(api);

      const messages = [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi' },
      ];

      await api._trigger('agent_end', { messages }, { sessionId: 'sess-1' });
      mockAdd.mockClear();

      // Same count — should skip
      await api._trigger('agent_end', { messages }, { sessionId: 'sess-1' });
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('re-ingests from start when count shrinks (compaction)', async () => {
      const api = createApi(tmpDir);
      plugin.register(api);

      // First call: 4 messages
      await api._trigger('agent_end', {
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
          { role: 'assistant', content: 'd' },
        ],
      }, { sessionId: 'sess-1' });

      mockAdd.mockClear();

      // Compacted to 2 messages — should re-ingest all from start
      await api._trigger('agent_end', {
        messages: [
          { role: 'user', content: 'compacted' },
          { role: 'assistant', content: 'summary' },
        ],
      }, { sessionId: 'sess-1' });

      expect(mockAdd).toHaveBeenCalledOnce();
      expect(mockAdd).toHaveBeenCalledWith(
        [
          { role: 'user', content: 'compacted' },
          { role: 'assistant', content: 'summary' },
        ],
        { userId: undefined },
      );
    });

    it('skips when no sessionId', async () => {
      const api = createApi(tmpDir);
      plugin.register(api);

      await api._trigger('agent_end', {
        messages: [{ role: 'user', content: 'hello' }],
      }, {});

      expect(mockAdd).not.toHaveBeenCalled();
    });

    it('writes progress file after ingest', async () => {
      const api = createApi(tmpDir);
      plugin.register(api);

      await api._trigger('agent_end', {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
        ],
      }, { sessionId: 'sess-1' });

      const progressPath = join(tmpDir, 'memory.progress.json');
      expect(existsSync(progressPath)).toBe(true);
      const data = JSON.parse(readFileSync(progressPath, 'utf-8'));
      expect(data['main:sess-1']).toBe(2);
    });

    it('redacts secrets before ingesting', async () => {
      const api = createApi(tmpDir);
      plugin.register(api);

      await api._trigger('agent_end', {
        messages: [
          { role: 'user', content: 'my key is sk-abcdefghij0123456789extra' },
        ],
      }, { sessionId: 'sess-1' });

      expect(mockAdd).toHaveBeenCalledWith(
        [{ role: 'user', content: 'my key is [REDACTED]' }],
        { userId: undefined },
      );
    });
  });

  describe('before_prompt_build hook', () => {
    it('returns prependContext with search results', async () => {
      mockSearch.mockResolvedValue([
        { content: 'user likes coffee' },
        { content: 'user is a developer' },
      ]);
      const api = createApi(tmpDir);
      plugin.register(api);

      const result = await api._trigger('before_prompt_build', {
        messages: [{ role: 'user', content: 'tell me about myself' }],
      }, { agentId: 'main' });

      expect(result).toEqual({
        prependContext: '## Relevant memories\n- user likes coffee\n- user is a developer',
      });
    });

    it('recalls for non-main agents seeded from DB', async () => {
      mockGetAgents.mockReturnValue([{ id: 'analytics' }]);
      mockSearch.mockResolvedValue([{ content: 'relevant memory' }]);
      const api = createApi(tmpDir);
      plugin.register(api);

      const result = await api._trigger('before_prompt_build', {
        messages: [{ role: 'user', content: 'query' }],
      }, { agentId: 'analytics' });

      expect(mockAgent).toHaveBeenCalledWith('analytics');
      expect(result).toEqual({
        prependContext: '## Relevant memories\n- relevant memory',
      });
    });

    it('skips for unknown agents (no memories yet)', async () => {
      mockGetAgents.mockReturnValue([]);
      const api = createApi(tmpDir);
      plugin.register(api);

      const result = await api._trigger('before_prompt_build', {
        messages: [{ role: 'user', content: 'query' }],
      }, { agentId: 'never-seen' });

      expect(mockSearch).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('skips when no user message', async () => {
      const api = createApi(tmpDir);
      plugin.register(api);

      const result = await api._trigger('before_prompt_build', {
        messages: [{ role: 'assistant', content: 'only assistant' }],
      }, { agentId: 'main' });

      expect(mockSearch).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it('returns undefined when no search results', async () => {
      mockSearch.mockResolvedValue([]);
      const api = createApi(tmpDir);
      plugin.register(api);

      const result = await api._trigger('before_prompt_build', {
        messages: [{ role: 'user', content: 'query' }],
      }, { agentId: 'main' });

      expect(result).toBeUndefined();
    });
  });
});
