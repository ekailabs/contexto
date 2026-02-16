import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config before importing memory module
vi.mock('./config.js', () => ({
  MEMORY_URL: 'http://localhost:4005',
}));

import { fetchMemoryContext, formatMemoryBlock, ingestMessages, injectMemory } from './memory.js';

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

describe('injectMemory preserves original messages', () => {
  it('mutates the messages array in place', () => {
    const messages = [
      { role: 'user', content: 'hello' },
    ];
    const original = messages.map((m) => ({ ...m }));

    injectMemory(messages, '<memory>test</memory>');

    // Original copy is untouched
    expect(original[0].content).toBe('hello');
    expect(original).toHaveLength(1);

    // messages array was mutated
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe('<memory>test</memory>');
    expect(messages).toHaveLength(2);
  });

  it('prepends to existing system message', () => {
    const messages = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'hi' },
    ];
    const original = messages.map((m) => ({ ...m }));

    injectMemory(messages, '<memory>facts</memory>');

    // Original copy is untouched
    expect(original[0].content).toBe('You are helpful.');

    // messages[0] was mutated
    expect(messages[0].content).toBe('<memory>facts</memory>\n\nYou are helpful.');
    expect(messages).toHaveLength(2);
  });
});
