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
    it('message:received + message:sent create user/assistant turns', async () => {
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        userId: 'user-1',
        event: { content: 'Hello' },
      });
      await writer.append({
        hook: 'message:sent', agentId: 'a1', sessionId: 's1',
        event: { content: 'Hi there!', model: 'gpt-4' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
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

    it('message:transcribed upgrades last user turn content', async () => {
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { content: 'raw audio text', messageId: 'msg-1' },
      });
      await writer.append({
        hook: 'message:transcribed', agentId: 'a1', sessionId: 's1',
        ts: 1100,
        event: { content: 'cleaned transcript', messageId: 'msg-1' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('user');
      expect(session.turns[0].content).toBe('cleaned transcript');
    });

    it('message:preprocessed upgrades last user turn content', async () => {
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { content: 'original' },
      });
      await writer.append({
        hook: 'message:preprocessed', agentId: 'a1', sessionId: 's1',
        ts: 1100,
        event: { content: 'preprocessed version' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].content).toBe('preprocessed version');
    });

    it('dedup: received + transcribed + preprocessed collapse into 1 user turn', async () => {
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { content: 'raw', messageId: 'msg-1' },
      });
      await writer.append({
        hook: 'message:transcribed', agentId: 'a1', sessionId: 's1',
        ts: 1100,
        event: { content: 'transcribed', messageId: 'msg-1' },
      });
      await writer.append({
        hook: 'message:preprocessed', agentId: 'a1', sessionId: 's1',
        ts: 1200,
        event: { content: 'final', messageId: 'msg-1' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('user');
      expect(session.turns[0].content).toBe('final');
    });

    it('command:new and command:stop set timestamps', async () => {
      await writer.append({ hook: 'command:new', agentId: 'a1', sessionId: 's1', ts: 1000, event: {} });
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1', ts: 2000,
        event: { content: 'hi' },
      });
      await writer.append({ hook: 'command:stop', agentId: 'a1', sessionId: 's1', ts: 3000, event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.startedAt).toBe(1000);
      expect(session.endedAt).toBe(3000);
      expect(session.turns).toHaveLength(1); // command:new/stop are not turns
    });

    it('command:reset creates a system turn', async () => {
      await writer.append({
        hook: 'command:reset', agentId: 'a1', sessionId: 's1',
        event: { content: 'conversation reset' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('conversation reset');
    });

    it('agent:bootstrap creates a system turn', async () => {
      await writer.append({
        hook: 'agent:bootstrap', agentId: 'a1', sessionId: 's1',
        event: { content: 'agent started' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('agent started');
    });

    it('gateway:startup creates a system turn', async () => {
      await writer.append({
        hook: 'gateway:startup', agentId: 'a1', sessionId: 's1',
        event: {},
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('gateway:startup');
    });

    it('tool_result_persist creates a tool turn', async () => {
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        userId: 'alice',
        event: { content: 'run the tool' },
      });
      await writer.append({
        hook: 'tool_result_persist', agentId: 'a1', sessionId: 's1',
        event: { content: 'tool output', toolCallId: 'tc-1' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[1].role).toBe('tool');
      expect(session.turns[1].content).toBe('tool output');
      expect(session.turns[1].toolCallId).toBe('tc-1');
      expect(session.turns[1].userId).toBe('alice');
      expect(session.turns[1].userAttribution).toBe('inferred');
    });

    it('tracks userId attribution correctly', async () => {
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        userId: 'alice',
        event: { content: 'hi' },
      });
      await writer.append({
        hook: 'message:sent', agentId: 'a1', sessionId: 's1',
        event: { content: 'hello' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].userAttribution).toBe('explicit');
      expect(session.turns[0].userId).toBe('alice');
      expect(session.turns[1].userAttribution).toBe('inferred');
      expect(session.turns[1].userId).toBe('alice');
    });

    it('marks unknown attribution when no userId available', async () => {
      await writer.append({
        hook: 'message:sent', agentId: 'a1', sessionId: 's1',
        event: { content: 'orphan response' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].userAttribution).toBe('unknown');
      expect(session.turns[0].userId).toBeUndefined();
    });

    it('extracts content from event.context.content', async () => {
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        event: { context: { content: 'from context' } },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].content).toBe('from context');
    });

    it('extracts content from event.messages[0]', async () => {
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        event: { messages: [{ content: 'from messages array' }] },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].content).toBe('from messages array');
    });

    it('reconstructs in eventTs order, not write order', async () => {
      await writer.append({
        hook: 'message:sent', agentId: 'a1', sessionId: 's1',
        ts: 2000,
        event: { content: 'response' },
      });
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1',
        ts: 1000,
        event: { content: 'question' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[0].role).toBe('user');
      expect(session.turns[0].content).toBe('question');
      expect(session.turns[1].role).toBe('assistant');
      expect(session.turns[1].content).toBe('response');
    });

    it('extracts token usage from message:sent', async () => {
      await writer.append({
        hook: 'message:sent', agentId: 'a1', sessionId: 's1',
        event: {
          content: 'response',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].inputTokens).toBe(100);
      expect(session.turns[0].outputTokens).toBe(50);
    });

    it('unrecognized hooks become system turns', async () => {
      await writer.append({ hook: 'some:future:hook', agentId: 'a1', sessionId: 's1', event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('some:future:hook');
    });

    // --- Plugin lifecycle hooks (api.on) ---

    it('session_start/session_end set timestamps', async () => {
      await writer.append({ hook: 'session_start', agentId: 'a1', sessionId: 's1', ts: 1000, event: {} });
      await writer.append({ hook: 'message_received', agentId: 'a1', sessionId: 's1', ts: 2000, userId: 'u1', event: { content: 'hi' } });
      await writer.append({ hook: 'session_end', agentId: 'a1', sessionId: 's1', ts: 3000, event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.startedAt).toBe(1000);
      expect(session.endedAt).toBe(3000);
      expect(session.turns).toHaveLength(1); // session_start/end are not turns
    });

    it('message_received → user turn, message_sent → assistant turn', async () => {
      await writer.append({
        hook: 'message_received', agentId: 'a1', sessionId: 's1',
        userId: 'alice',
        event: { content: 'Hello', from: 'alice' },
      });
      await writer.append({
        hook: 'message_sent', agentId: 'a1', sessionId: 's1',
        event: { content: 'Hi there!', model: 'claude-3' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[0].role).toBe('user');
      expect(session.turns[0].content).toBe('Hello');
      expect(session.turns[0].userId).toBe('alice');
      expect(session.turns[0].userAttribution).toBe('explicit');
      expect(session.turns[1].role).toBe('assistant');
      expect(session.turns[1].content).toBe('Hi there!');
      expect(session.turns[1].model).toBe('claude-3');
    });

    it('llm_input → system turn with model', async () => {
      await writer.append({
        hook: 'llm_input', agentId: 'a1', sessionId: 's1',
        event: { content: 'system prompt', model: 'claude-3', provider: 'anthropic' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('system prompt');
      expect(session.turns[0].model).toBe('claude-3');
    });

    it('llm_output → assistant turn with model, usage, content', async () => {
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        userId: 'bob',
        event: {
          content: 'LLM response',
          model: 'gpt-4',
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('assistant');
      expect(session.turns[0].content).toBe('LLM response');
      expect(session.turns[0].model).toBe('gpt-4');
      expect(session.turns[0].inputTokens).toBe(200);
      expect(session.turns[0].outputTokens).toBe(100);
    });

    it('llm_output then message_sent with same content → single assistant turn (strict dedup)', async () => {
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1', ts: 1000,
        event: { content: 'Same response', model: 'claude-3', usage: { input_tokens: 50, output_tokens: 25 } },
      });
      await writer.append({
        hook: 'message_sent', agentId: 'a1', sessionId: 's1', ts: 1001,
        event: { content: 'Same response' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('assistant');
      expect(session.turns[0].content).toBe('Same response');
      expect(session.turns[0].model).toBe('claude-3');
    });

    it('llm_output then message:sent with same content → cross-naming strict dedup', async () => {
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1', ts: 1000,
        event: { content: 'Deduped content', model: 'claude-3' },
      });
      await writer.append({
        hook: 'message:sent', agentId: 'a1', sessionId: 's1', ts: 1001,
        event: { content: 'Deduped content' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('assistant');
      expect(session.turns[0].content).toBe('Deduped content');
    });

    it('llm_output then message_sent with DIFFERENT content → both turns kept', async () => {
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1', ts: 1000,
        event: { content: 'Raw LLM output' },
      });
      await writer.append({
        hook: 'message_sent', agentId: 'a1', sessionId: 's1', ts: 1001,
        event: { content: 'Modified delivery' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[0].content).toBe('Raw LLM output');
      expect(session.turns[1].content).toBe('Modified delivery');
    });

    it('before_tool_call + after_tool_call pairing by toolName sequence', async () => {
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1', ts: 1000,
        event: { toolName: 'search', params: { q: 'test' } },
      });
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1', ts: 1100,
        event: { toolName: 'search', result: { hits: 5 }, durationMs: 100 },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('tool');
      expect(session.turns[0].toolCalls).toHaveLength(1);
      expect(session.turns[0].toolCalls![0].toolName).toBe('search');
      expect(session.turns[0].toolCalls![0].arguments).toEqual({ q: 'test' });
      expect(session.turns[0].toolCalls![0].result).toEqual({ hits: 5 });
      expect(session.turns[0].toolCalls![0].status).toBe('success');
      expect(session.turns[0].toolCalls![0].durationMs).toBe(100);
    });

    it('after_tool_call with error marks tool error status', async () => {
      await writer.append({
        hook: 'before_tool_call', agentId: 'a1', sessionId: 's1', ts: 1000,
        event: { toolName: 'fetch', params: { url: 'http://bad' } },
      });
      await writer.append({
        hook: 'after_tool_call', agentId: 'a1', sessionId: 's1', ts: 1100,
        event: { toolName: 'fetch', error: 'timeout', durationMs: 5000 },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].toolCalls![0].status).toBe('error');
      expect(session.turns[0].toolCalls![0].error).toBe('timeout');
    });

    it('before_prompt_build → system turn', async () => {
      await writer.append({
        hook: 'before_prompt_build', agentId: 'a1', sessionId: 's1',
        event: { content: 'building prompt' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('building prompt');
    });

    it('before_compaction/after_compaction → system turns', async () => {
      await writer.append({
        hook: 'before_compaction', agentId: 'a1', sessionId: 's1',
        event: { content: 'compacting context' },
      });
      await writer.append({
        hook: 'after_compaction', agentId: 'a1', sessionId: 's1',
        event: { content: 'compaction done' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('compacting context');
      expect(session.turns[1].content).toBe('compaction done');
    });

    it('before_reset → system turn', async () => {
      await writer.append({
        hook: 'before_reset', agentId: 'a1', sessionId: 's1',
        event: { content: 'resetting context' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('resetting context');
    });

    it('agent_end sets endedAt', async () => {
      await writer.append({ hook: 'session_start', agentId: 'a1', sessionId: 's1', ts: 1000, event: {} });
      await writer.append({ hook: 'agent_end', agentId: 'a1', sessionId: 's1', ts: 5000, event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.endedAt).toBe(5000);
      expect(session.turns).toHaveLength(0); // neither creates a turn
    });

    it('agent_end does not override session_end endedAt', async () => {
      await writer.append({ hook: 'session_end', agentId: 'a1', sessionId: 's1', ts: 3000, event: {} });
      await writer.append({ hook: 'agent_end', agentId: 'a1', sessionId: 's1', ts: 5000, event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.endedAt).toBe(3000);
    });

    it('subagent_spawned/subagent_ended → system turns', async () => {
      await writer.append({
        hook: 'subagent_spawned', agentId: 'a1', sessionId: 's1',
        event: { content: 'child spawned' },
      });
      await writer.append({
        hook: 'subagent_ended', agentId: 'a1', sessionId: 's1',
        event: { content: 'child ended' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('child spawned');
      expect(session.turns[1].content).toBe('child ended');
    });

    it('gateway_start/gateway_stop → system turns', async () => {
      await writer.append({ hook: 'gateway_start', agentId: 'a1', sessionId: 's1', event: {} });
      await writer.append({ hook: 'gateway_stop', agentId: 'a1', sessionId: 's1', event: {} });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(2);
      expect(session.turns[0].role).toBe('system');
      expect(session.turns[0].content).toBe('gateway_start');
      expect(session.turns[1].content).toBe('gateway_stop');
    });

    it('skipped hooks do not create turns', async () => {
      const skippedHooks = [
        'before_model_resolve', 'before_agent_start', 'message_sending',
        'before_message_write', 'subagent_spawning', 'subagent_delivery_target',
      ];
      for (const hook of skippedHooks) {
        await writer.append({ hook, agentId: 'a1', sessionId: 's1', event: { data: 'test' } });
      }

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(0);
    });

    it('userId attribution tracks across lifecycle hooks', async () => {
      await writer.append({
        hook: 'message_received', agentId: 'a1', sessionId: 's1',
        userId: 'alice',
        event: { content: 'hi', from: 'alice' },
      });
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        event: { content: 'response' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns[0].userId).toBe('alice');
      expect(session.turns[0].userAttribution).toBe('explicit');
      expect(session.turns[1].userId).toBe('alice');
      expect(session.turns[1].userAttribution).toBe('inferred');
    });

    it('message_received dedup: consecutive user turns with same content from different naming', async () => {
      await writer.append({
        hook: 'message_received', agentId: 'a1', sessionId: 's1', ts: 1000,
        event: { content: 'same msg' },
      });
      await writer.append({
        hook: 'message:received', agentId: 'a1', sessionId: 's1', ts: 1001,
        event: { content: 'same msg' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].content).toBe('same msg');
    });

    it('llm_output extracts content from assistantTexts', async () => {
      await writer.append({
        hook: 'llm_output', agentId: 'a1', sessionId: 's1',
        event: { assistantTexts: ['Hello', 'World'], model: 'claude-3' },
      });

      const session = await reader.reconstructSession('a1', 's1');
      expect(session.turns).toHaveLength(1);
      expect(session.turns[0].content).toBe('Hello\nWorld');
    });
  });

  describe('ID flow: listAgents → listSessions → readSession', () => {
    it('list output is directly usable as input to downstream methods', async () => {
      await writer.append({ hook: 'command:new', agentId: 'my-agent', sessionId: 'sess-1', event: {} });
      await writer.append({ hook: 'message:received', agentId: 'my-agent', sessionId: 'sess-1', event: { content: 'hi' } });

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
