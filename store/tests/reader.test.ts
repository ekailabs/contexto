import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventWriter } from '../src/writer.js';
import { EventReader } from '../src/reader.js';
import { sanitizeId } from '../src/types.js';

describe('EventReader', () => {
  let dataDir: string;
  let writer: EventWriter;
  let reader: EventReader;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ekai-store-test-'));
    writer = new EventWriter(dataDir);
    reader = new EventReader(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('listAgents', () => {
    it('returns empty array when no data', async () => {
      expect(await reader.listAgents()).toEqual([]);
    });

    it('lists agent directories sorted lexically', async () => {
      await writer.append({ hook: 'session_start', agentId: 'beta', sessionId: 's1', event: {} });
      await writer.append({ hook: 'session_start', agentId: 'alpha', sessionId: 's1', event: {} });

      const agents = await reader.listAgents();
      expect(agents).toHaveLength(2);
      // Lexical sort of sanitized names
      expect(agents[0] < agents[1]).toBe(true);
    });
  });

  describe('listSessions', () => {
    it('returns empty array for unknown agent', async () => {
      expect(await reader.listSessions('nonexistent')).toEqual([]);
    });

    it('lists sessions sorted by mtime (newest first)', async () => {
      await writer.append({ hook: 'session_start', agentId: 'a1', sessionId: 'old', event: {} });
      // Small delay to ensure different mtime
      await new Promise(r => setTimeout(r, 50));
      await writer.append({ hook: 'session_start', agentId: 'a1', sessionId: 'new', event: {} });

      const sessions = await reader.listSessions('a1');
      expect(sessions).toHaveLength(2);
      // Newest first
      expect(sessions[0]).toBe(sanitizeId('new', 'session'));
      expect(sessions[1]).toBe(sanitizeId('old', 'session'));
    });

    it('sanitizes agentId input', async () => {
      await writer.append({ hook: 'session_start', agentId: 'my/agent', sessionId: 's1', event: {} });
      const sessions = await reader.listSessions('my/agent');
      expect(sessions).toHaveLength(1);
    });
  });

  describe('readSession', () => {
    it('returns empty array for missing session', async () => {
      expect(await reader.readSession('a1', 's1')).toEqual([]);
    });

    it('reads all events from a session', async () => {
      await writer.append({ hook: 'session_start', agentId: 'a1', sessionId: 's1', event: {} });
      await writer.append({ hook: 'message_received', agentId: 'a1', sessionId: 's1', event: { text: 'hi' } });
      await writer.append({ hook: 'session_end', agentId: 'a1', sessionId: 's1', event: {} });

      const events = await reader.readSession('a1', 's1');
      expect(events).toHaveLength(3);
      expect(events.map(e => e.hook)).toEqual(['session_start', 'message_received', 'session_end']);
    });

    it('sanitizes input IDs', async () => {
      await writer.append({ hook: 'session_start', agentId: 'a/1', sessionId: 's/1', event: {} });
      const events = await reader.readSession('a/1', 's/1');
      expect(events).toHaveLength(1);
    });

    it('skips malformed lines', async () => {
      // Write directly to inject a malformed line
      const sAgent = sanitizeId('a1', 'agent');
      const sSession = sanitizeId('s1', 'session');
      const dir = join(dataDir, sAgent);
      mkdirSync(dir, { recursive: true });
      const filePath = join(dir, `${sSession}.jsonl`);
      appendFileSync(filePath, '{"hook":"session_start","id":"1","v":1,"eventTs":0,"ingestTs":0,"sessionId":"s","agentId":"a","event":{}}\n');
      appendFileSync(filePath, 'NOT_VALID_JSON\n');
      appendFileSync(filePath, '{"hook":"session_end","id":"2","v":1,"eventTs":0,"ingestTs":0,"sessionId":"s","agentId":"a","event":{}}\n');

      const events = await reader.readSession('a1', 's1');
      expect(events).toHaveLength(2);
    });

    it('deduplicates by id when dedupe=true', async () => {
      await writer.append({ id: 'same-id', hook: 'message_received', agentId: 'a1', sessionId: 's1', event: { n: 1 } });
      await writer.append({ id: 'same-id', hook: 'message_received', agentId: 'a1', sessionId: 's1', event: { n: 2 } });
      await writer.append({ id: 'diff-id', hook: 'message_received', agentId: 'a1', sessionId: 's1', event: { n: 3 } });

      const raw = await reader.readSession('a1', 's1');
      expect(raw).toHaveLength(3);

      const deduped = await reader.readSession('a1', 's1', { dedupe: true });
      expect(deduped).toHaveLength(2);
      expect(deduped[0].id).toBe('same-id');
      expect(deduped[1].id).toBe('diff-id');
    });
  });

  describe('reconstructSession', () => {
    it('reconstructs a basic session with user and assistant turns', async () => {
      await writer.append({ hook: 'session_start', agentId: 'a1', sessionId: 's1', event: {} });
      await writer.append({
        hook: 'message_received', agentId: 'a1', sessionId: 's1',
        userId: 'user-1',
        event: { content: 'Hello' },
      });
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        event: { content: 'Hi there!', model: 'gpt-4' },
      });
      await writer.append({ hook: 'session_end', agentId: 'a1', sessionId: 's1', event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2); // user + assistant (session_start/end are not turns)
      expect(session.turns[0].role).toBe('user');
      expect(session.turns[0].content).toBe('Hello');
      expect(session.turns[0].userId).toBe('user-1');
      expect(session.turns[0].userAttribution).toBe('explicit');

      expect(session.turns[1].role).toBe('assistant');
      expect(session.turns[1].content).toBe('Hi there!');
      expect(session.turns[1].model).toBe('gpt-4');
      expect(session.turns[1].userId).toBe('user-1');
      expect(session.turns[1].userAttribution).toBe('inferred');
    });

    it('respects event.role over hook-name heuristic', async () => {
      await writer.append({
        hook: 'message_received', agentId: 'a1', sessionId: 's1',
        event: { role: 'system', content: 'System prompt' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].role).toBe('system');
    });

    it('pairs tool calls by toolCallId', async () => {
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { toolCallId: 'tc-1', toolName: 'search', arguments: { q: 'test' } },
      });
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 1500,
        event: { toolCallId: 'tc-1', toolName: 'search', result: { hits: 5 }, durationMs: 500 },
      });

      const session = await reader.reconstructSession('a1', 's1');
      const toolTurn = session.turns.find(t => t.role === 'tool');
      expect(toolTurn).toBeDefined();
      expect(toolTurn!.toolCalls![0].status).toBe('success');
      expect(toolTurn!.toolCalls![0].result).toEqual({ hits: 5 });
      expect(toolTurn!.toolCalls![0].durationMs).toBe(500);
    });

    it('pairs tool calls by runId + toolName', async () => {
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { runId: 'run-1', toolName: 'fetch', arguments: { url: 'http://x' } },
      });
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 2000,
        event: { runId: 'run-1', toolName: 'fetch', result: 'ok' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      const toolTurn = session.turns.find(t => t.role === 'tool');
      expect(toolTurn!.toolCalls![0].status).toBe('success');
      expect(toolTurn!.toolCalls![0].result).toBe('ok');
    });

    it('pairs tool calls by sequence (fallback)', async () => {
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { toolName: 'calc', arguments: { x: 1 } },
      });
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 1200,
        event: { toolName: 'calc', result: 42 },
      });

      const session = await reader.reconstructSession('a1', 's1');
      const toolTurn = session.turns.find(t => t.role === 'tool');
      expect(toolTurn!.toolCalls![0].status).toBe('success');
      expect(toolTurn!.toolCalls![0].result).toBe(42);
    });

    it('preserves explicit durationMs: 0 without overwriting', async () => {
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { toolCallId: 'tc-zero', toolName: 'fast', arguments: {} },
      });
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 2000,
        event: { toolCallId: 'tc-zero', toolName: 'fast', result: 'ok', durationMs: 0 },
      });

      const session = await reader.reconstructSession('a1', 's1');
      const toolTurn = session.turns.find(t => t.role === 'tool');
      expect(toolTurn!.toolCalls![0].durationMs).toBe(0);
    });

    it('marks tool errors correctly', async () => {
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1',
        event: { toolCallId: 'tc-err', toolName: 'fail', arguments: {} },
      });
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1',
        event: { toolCallId: 'tc-err', toolName: 'fail', error: 'timeout' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      const toolTurn = session.turns.find(t => t.role === 'tool');
      expect(toolTurn!.toolCalls![0].status).toBe('error');
      expect(toolTurn!.toolCalls![0].error).toBe('timeout');
    });

    it('extracts tool calls from llm_output', async () => {
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        event: {
          content: 'Let me search for that.',
          tool_calls: [
            { id: 'tc-1', function: { name: 'search', arguments: '{"q":"test"}' } },
          ],
        },
      });

      const session = await reader.reconstructSession('a1', 's1');
      const assistantTurn = session.turns.find(t => t.role === 'assistant');
      expect(assistantTurn!.toolCalls).toHaveLength(1);
      expect(assistantTurn!.toolCalls![0].toolName).toBe('search');
      expect(assistantTurn!.toolCalls![0].arguments).toEqual({ q: 'test' });
    });

    it('tracks userId attribution correctly', async () => {
      // User turn with explicit userId
      await writer.append({
        hook: 'message_received', agentId: 'a1', sessionId: 's1',
        userId: 'alice',
        event: { content: 'hi' },
      });
      // Assistant turn — should infer userId
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        event: { content: 'hello' },
      });
      // Tool turn — should infer userId
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1',
        event: { toolCallId: 'tc-1', toolName: 'search', arguments: {} },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].userAttribution).toBe('explicit');
      expect(session.turns[0].userId).toBe('alice');

      expect(session.turns[1].userAttribution).toBe('inferred');
      expect(session.turns[1].userId).toBe('alice');

      expect(session.turns[2].userAttribution).toBe('inferred');
      expect(session.turns[2].userId).toBe('alice');
    });

    it('marks unknown attribution when no userId available', async () => {
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        event: { content: 'orphan response' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].userAttribution).toBe('unknown');
      expect(session.turns[0].userId).toBeUndefined();
    });

    it('extracts token usage from llm_output', async () => {
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        event: {
          content: 'response',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].inputTokens).toBe(100);
      expect(session.turns[0].outputTokens).toBe(50);
    });

    it('handles session_start and session_end timestamps', async () => {
      await writer.append({ hook: 'session_start', agentId: 'a1', sessionId: 's1', ts: 1000, event: {} });
      await writer.append({ hook: 'message_received', agentId: 'a1', sessionId: 's1', ts: 2000, event: { content: 'hi' } });
      await writer.append({ hook: 'session_end', agentId: 'a1', sessionId: 's1', ts: 3000, event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.startedAt).toBe(1000);
      expect(session.endedAt).toBe(3000);
    });

    it('creates system turns for unrecognized hooks', async () => {
      await writer.append({ hook: 'before_prompt_build', agentId: 'a1', sessionId: 's1', event: {} });
      await writer.append({ hook: 'agent_end', agentId: 'a1', sessionId: 's1', event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('before_prompt_build');
      expect(session.turns[1].content).toBe('agent_end');
    });

    it('handles message_sent hook', async () => {
      await writer.append({
        hook: 'message_sent', agentId: 'a1', sessionId: 's1',
        event: { content: 'sent reply' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].role).toBe('assistant');
      expect(session.turns[0].content).toBe('sent reply');
    });

    it('reconstructs in eventTs order, not write order', async () => {
      // Write out of chronological order
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        ts: 2000,
        event: { content: 'response' },
      });
      await writer.append({
        hook: 'message_received', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { content: 'question' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[0].role).toBe('user');
      expect(session.turns[0].content).toBe('question');
      expect(session.turns[0].timestamp).toBe(1000);
      expect(session.turns[1].role).toBe('assistant');
      expect(session.turns[1].content).toBe('response');
      expect(session.turns[1].timestamp).toBe(2000);
    });

    it('does not double-match a before_tool_call with multiple indexes', async () => {
      // before_tool_call registered under both toolCallId and runId+toolName
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { toolCallId: 'tc-1', runId: 'run-1', toolName: 'search', arguments: { q: 'a' } },
      });
      // First after matches by toolCallId
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 1500,
        event: { toolCallId: 'tc-1', toolName: 'search', result: 'first' },
      });
      // Second after tries runId — should NOT match the already-paired entry
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1',
        ts: 2000,
        event: { runId: 'run-1', toolName: 'search', result: 'second' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      const toolTurn = session.turns.find(t => t.role === 'tool');
      expect(toolTurn!.toolCalls![0].result).toBe('first');
      expect(toolTurn!.toolCalls![0].status).toBe('success');
    });
  });

  describe('ID flow: listAgents → listSessions → readSession', () => {
    it('list output is directly usable as input to downstream methods', async () => {
      await writer.append({ hook: 'session_start', agentId: 'my-agent', sessionId: 'sess-1', event: {} });
      await writer.append({ hook: 'message_received', agentId: 'my-agent', sessionId: 'sess-1', event: { content: 'hi' } });

      const agents = await reader.listAgents();
      expect(agents).toHaveLength(1);

      const sessions = await reader.listSessions(agents[0]);
      expect(sessions).toHaveLength(1);

      const events = await reader.readSession(agents[0], sessions[0]);
      expect(events).toHaveLength(2);

      const session = await reader.reconstructSession(agents[0], sessions[0]);
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].content).toBe('hi');
    });

    it('raw IDs still work as input (backward compat)', async () => {
      await writer.append({ hook: 'session_start', agentId: 'raw-agent', sessionId: 'raw-sess', event: {} });

      const sessions = await reader.listSessions('raw-agent');
      expect(sessions).toHaveLength(1);

      const events = await reader.readSession('raw-agent', 'raw-sess');
      expect(events).toHaveLength(1);
    });

    it('rejects path-traversal attempts in agentId', async () => {
      await writer.append({ hook: 'session_start', agentId: 'legit', sessionId: 's1', event: {} });

      // '..' would resolve to parent of dataDir — must not be trusted
      const events = await reader.readSession('..', 's1');
      expect(events).toEqual([]);

      const sessions = await reader.listSessions('..');
      expect(sessions).toEqual([]);
    });

    it('rejects path-traversal attempts in sessionId', async () => {
      await writer.append({ hook: 'session_start', agentId: 'a1', sessionId: 's1', event: {} });

      const events = await reader.readSession('a1', '../../../etc/passwd');
      expect(events).toEqual([]);
    });
  });
});
