import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing memory module
vi.mock('./config.js', () => ({
  MEMORY_URL: 'http://localhost:4005',
}));

import { fetchMemoryContext, formatMemoryBlock, ingestMessages, injectMemory } from './memory.js';

describe('formatMemoryBlock', () => {
  it('formats semantic facts under "What I know:"', () => {
    const results = [
      {
        sector: 'semantic' as const,
        content: 'Sha prefers dark mode',
        score: 0.9,
        details: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
      },
    ];
    const block = formatMemoryBlock(results);
    expect(block).toContain('What I know:');
    expect(block).toContain('- Sha prefers dark mode');
    expect(block).not.toContain('Facts:');
  });

  it('formats episodic events under "What I remember:"', () => {
    const results = [
      {
        sector: 'episodic' as const,
        content: 'I discussed project architecture with Sha on Monday',
        score: 0.8,
      },
    ];
    const block = formatMemoryBlock(results);
    expect(block).toContain('What I remember:');
    expect(block).toContain('- I discussed project architecture with Sha on Monday');
    expect(block).not.toContain('Events:');
  });

  it('formats procedural memories under "How I do things:"', () => {
    const results = [
      {
        sector: 'procedural' as const,
        content: 'deploy to production',
        score: 0.7,
        details: {
          trigger: 'user asks to deploy',
          steps: ['run tests', 'build', 'push to main'],
        },
      },
    ];
    const block = formatMemoryBlock(results);
    expect(block).toContain('How I do things:');
    expect(block).toContain('When user asks to deploy: run tests → build → push to main');
    expect(block).not.toContain('Procedures:');
  });

  it('formats reflective observations under "My observations:"', () => {
    const results = [
      {
        sector: 'reflective' as const,
        content: 'I tend to give overly detailed answers when a short response would suffice',
        score: 0.6,
      },
    ];
    const block = formatMemoryBlock(results);
    expect(block).toContain('My observations:');
    expect(block).toContain('- I tend to give overly detailed answers when a short response would suffice');
  });

  it('groups all four sectors correctly', () => {
    const results = [
      {
        sector: 'semantic' as const,
        content: 'TypeScript supports generics',
        score: 0.9,
        details: { subject: 'TypeScript', predicate: 'supports', object: 'generics' },
      },
      {
        sector: 'episodic' as const,
        content: 'I helped debug a memory leak yesterday',
        score: 0.8,
      },
      {
        sector: 'procedural' as const,
        content: 'run tests',
        score: 0.7,
        details: { trigger: 'before commit', steps: ['lint', 'test', 'build'] },
      },
      {
        sector: 'reflective' as const,
        content: 'Sha responds better when I lead with the conclusion',
        score: 0.6,
      },
    ];
    const block = formatMemoryBlock(results);
    expect(block).toContain('What I know:');
    expect(block).toContain('What I remember:');
    expect(block).toContain('How I do things:');
    expect(block).toContain('My observations:');
    expect(block).toContain('<memory>');
    expect(block).toContain('</memory>');
  });

  it('omits empty sections', () => {
    const results = [
      {
        sector: 'reflective' as const,
        content: 'I noticed a pattern',
        score: 0.5,
      },
    ];
    const block = formatMemoryBlock(results);
    expect(block).toContain('My observations:');
    expect(block).not.toContain('What I know:');
    expect(block).not.toContain('What I remember:');
    expect(block).not.toContain('How I do things:');
  });
});

describe('ingestMessages', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs messages and profile to /v1/ingest', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const messages = [
      { role: 'user', content: 'My dog is named Luna' },
    ];

    ingestMessages(messages, 'test-profile');

    // Let the fire-and-forget promise settle
    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('http://localhost:4005/v1/ingest');
    expect(options).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    const body = JSON.parse(options!.body as string);
    expect(body.messages).toEqual(messages);
    expect(body.profile).toBe('test-profile');
  });

  it('logs and swallows fetch errors', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockRejectedValueOnce(new Error('connection refused'));

    ingestMessages([{ role: 'user', content: 'hello' }], 'default');

    await vi.waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        '[memory] ingest failed: connection refused',
      );
    });
  });
});

describe('injectMemory', () => {
  it('does not mutate the original messages array', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const result = injectMemory(messages, '<memory>test</memory>');
    expect(messages).toHaveLength(1);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('system');
  });

  it('prepends memory before existing system message content', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ];
    const result = injectMemory(messages, '<memory>facts</memory>');
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('<memory>facts</memory>\n\nYou are helpful.');
    // Original untouched
    expect(messages[0].content).toBe('You are helpful.');
  });

  it('returns original array unchanged if memoryBlock is empty', () => {
    const messages = [{ role: 'user', content: 'hello' }];
    const result = injectMemory(messages, '');
    expect(result).toBe(messages);
  });
});
