import { access, readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sanitizeId } from './types.js';
import type { StoreEvent, ReconstructedSession, ReconstructedTurn } from './types.js';

export class EventReader {
  constructor(private dataDir: string) {}

  /** Check if a path exists. */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await access(p);
      return true;
    } catch {
      return false;
    }
  }

  /** Check that a resolved path stays within dataDir (prevents traversal). */
  private isInsideDataDir(candidate: string): boolean {
    const resolvedDataDir = resolve(this.dataDir);
    const resolvedCandidate = resolve(candidate);
    return resolvedCandidate.startsWith(resolvedDataDir + '/') || resolvedCandidate === resolvedDataDir;
  }

  /**
   * Resolve an agentId to its directory name.
   * Accepts both raw IDs (sanitizes them) and already-sanitized IDs (from listAgents output).
   */
  private async resolveAgent(agentId: string): Promise<string> {
    const candidatePath = join(this.dataDir, agentId);
    if (this.isInsideDataDir(candidatePath) && await this.pathExists(candidatePath)) return agentId;
    return sanitizeId(agentId, 'agent');
  }

  /**
   * Resolve a sessionId to its file stem.
   * Accepts both raw IDs and already-sanitized IDs (from listSessions output).
   */
  private async resolveSession(agentDir: string, sessionId: string): Promise<string> {
    const candidatePath = join(this.dataDir, agentDir, `${sessionId}.jsonl`);
    if (this.isInsideDataDir(candidatePath) && await this.pathExists(candidatePath)) return sessionId;
    return sanitizeId(sessionId, 'session');
  }

  /** List all agent directories, sorted lexically. */
  async listAgents(): Promise<string[]> {
    try {
      const entries = await readdir(this.dataDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** List sessions for an agent, sorted by mtime (newest first). Accepts raw or sanitized agentId. */
  async listSessions(agentId: string): Promise<string[]> {
    const resolved = await this.resolveAgent(agentId);
    const dir = join(this.dataDir, resolved);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const sessions = await Promise.all(
        entries
          .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
          .map(async e => {
            const name = e.name.replace(/\.jsonl$/, '');
            const s = await stat(join(dir, e.name));
            return { name, mtime: s.mtimeMs };
          })
      );
      sessions.sort((a, b) => b.mtime - a.mtime);
      return sessions.map(s => s.name);
    } catch {
      return [];
    }
  }

  /** Parse a JSONL file into events. Skips malformed lines. */
  private async readEventsFromFile(filePath: string, opts?: { dedupe?: boolean }): Promise<StoreEvent[]> {
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return [];
    }

    const events: StoreEvent[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }

    if (opts?.dedupe) {
      const seen = new Set<string>();
      return events.filter(e => {
        if (seen.has(e.id)) return false;
        seen.add(e.id);
        return true;
      });
    }

    return events;
  }

  /** Read all events from a session JSONL file. Accepts raw or sanitized IDs. Skips malformed lines. */
  async readSession(agentId: string, sessionId: string, opts?: { dedupe?: boolean }): Promise<StoreEvent[]> {
    const resolvedAgent = await this.resolveAgent(agentId);
    const resolvedSession = await this.resolveSession(resolvedAgent, sessionId);
    return this.readEventsFromFile(join(this.dataDir, resolvedAgent, `${resolvedSession}.jsonl`), opts);
  }

  /** Reconstruct a session from events into ordered turns. */
  async reconstructSession(agentId: string, sessionId: string): Promise<ReconstructedSession> {
    const resolvedAgent = await this.resolveAgent(agentId);
    const resolvedSession = await this.resolveSession(resolvedAgent, sessionId);
    const events = await this.readEventsFromFile(join(this.dataDir, resolvedAgent, `${resolvedSession}.jsonl`));

    // Sort by eventTs for chronological reconstruction
    events.sort((a, b) => a.eventTs - b.eventTs);

    const session: ReconstructedSession = {
      sessionId: resolvedSession,
      agentId: resolvedAgent,
      startedAt: events.length > 0 ? events[0].eventTs : 0,
      turns: [],
    };

    // Track last explicit userId for inference
    let lastExplicitUserId: string | undefined;

    // Track last user turn for inbound dedup (received → transcribed → preprocessed)
    let lastUserTurn: ReconstructedTurn | undefined;
    let lastUserMessageId: string | undefined;

    // Track last assistant turn for strict dedup (llm_output → message_sent)
    let lastAssistantTurn: ReconstructedTurn | undefined;

    // Tool-call pairing: pending before_tool_call turns indexed by sequence
    const pendingToolCalls: { turn: ReconstructedTurn; toolName: string }[] = [];

    // Hooks that are saved to JSONL but produce no turn in reconstruction
    const SKIPPED_HOOKS = new Set([
      'before_model_resolve', 'before_agent_start', 'message_sending',
      'before_message_write', 'subagent_spawning', 'subagent_delivery_target',
    ]);

    for (const ev of events) {
      const hook = ev.hook;
      const payload = ev.event ?? {};

      // --- Metadata-only hooks (no turn) ---

      if (hook === 'session_start') {
        session.startedAt = ev.eventTs;
        continue;
      }

      if (hook === 'session_end') {
        session.endedAt = ev.eventTs;
        continue;
      }

      if (hook === 'agent_end') {
        if (!session.endedAt) session.endedAt = ev.eventTs;
        continue;
      }

      // --- Legacy colon-separated hooks (backward compat) ---

      if (hook === 'command:new') {
        session.startedAt = ev.eventTs;
        continue;
      }

      if (hook === 'command:stop') {
        session.endedAt = ev.eventTs;
        continue;
      }

      if (hook === 'command:reset') {
        session.turns.push({
          role: 'system',
          content: extractContent(payload) ?? 'reset',
          timestamp: ev.eventTs,
          userAttribution: 'unknown',
        });
        lastUserTurn = undefined;
        lastUserMessageId = undefined;
        lastAssistantTurn = undefined;
        continue;
      }

      // --- User message hooks ---

      if (hook === 'message_received' || hook === 'message:received') {
        // Strict dedup: consecutive user turns with same content from different naming → collapse
        if (lastUserTurn && lastUserTurn.content != null && lastUserTurn.content === extractContent(payload)) {
          continue;
        }

        const content = extractContent(payload);
        const userId = ev.userId ?? payload.userId ?? payload.from ?? ev.event?.context?.from;
        if (userId) lastExplicitUserId = userId;
        const messageId = payload.messageId ?? payload.id;

        const turn: ReconstructedTurn = {
          role: 'user',
          content,
          userId,
          userAttribution: userId ? 'explicit' : 'unknown',
          timestamp: ev.eventTs,
        };
        session.turns.push(turn);
        lastUserTurn = turn;
        lastUserMessageId = messageId;
        lastAssistantTurn = undefined;
        continue;
      }

      if (hook === 'message:transcribed' || hook === 'message:preprocessed') {
        const content = extractContent(payload);
        const messageId = payload.messageId ?? payload.id;

        // Dedup: upgrade last user turn if messageId matches or it's the most recent user turn
        if (lastUserTurn && (messageId == null || lastUserMessageId == null || messageId === lastUserMessageId)) {
          if (content) lastUserTurn.content = content;
          continue;
        }

        // No matching user turn — create a new one
        const userId = ev.userId ?? payload.userId ?? ev.event?.context?.from;
        if (userId) lastExplicitUserId = userId;
        const turn: ReconstructedTurn = {
          role: 'user',
          content,
          userId,
          userAttribution: userId ? 'explicit' : 'unknown',
          timestamp: ev.eventTs,
        };
        session.turns.push(turn);
        lastUserTurn = turn;
        lastUserMessageId = messageId;
        lastAssistantTurn = undefined;
        continue;
      }

      // --- Assistant / LLM hooks ---

      if (hook === 'llm_input') {
        session.turns.push({
          role: 'system',
          content: extractContent(payload) ?? 'llm_input',
          model: payload.model,
          timestamp: ev.eventTs,
          userAttribution: 'unknown',
        });
        lastAssistantTurn = undefined;
        continue;
      }

      if (hook === 'llm_output') {
        const content = extractContent(payload) ?? payload.assistantTexts?.join('\n');
        const model = payload.model;
        const inputTokens = payload.usage?.input_tokens ?? payload.usage?.prompt_tokens;
        const outputTokens = payload.usage?.output_tokens ?? payload.usage?.completion_tokens;

        const turn: ReconstructedTurn = {
          role: 'assistant',
          content,
          model,
          userId: lastExplicitUserId,
          userAttribution: lastExplicitUserId ? 'inferred' : 'unknown',
          inputTokens,
          outputTokens,
          timestamp: ev.eventTs,
        };
        session.turns.push(turn);
        lastUserTurn = undefined;
        lastUserMessageId = undefined;
        lastAssistantTurn = turn;
        continue;
      }

      if (hook === 'message_sent' || hook === 'message:sent') {
        const content = extractContent(payload);

        // Strict dedup: if last turn was llm_output with same content, skip this
        if (lastAssistantTurn && lastAssistantTurn.content != null && lastAssistantTurn.content === content) {
          lastAssistantTurn = undefined;
          continue;
        }

        const model = payload.model;
        const inputTokens = payload.usage?.input_tokens ?? payload.usage?.prompt_tokens;
        const outputTokens = payload.usage?.output_tokens ?? payload.usage?.completion_tokens;

        session.turns.push({
          role: 'assistant',
          content,
          model,
          userId: lastExplicitUserId,
          userAttribution: lastExplicitUserId ? 'inferred' : 'unknown',
          inputTokens,
          outputTokens,
          timestamp: ev.eventTs,
        });
        lastUserTurn = undefined;
        lastUserMessageId = undefined;
        lastAssistantTurn = undefined;
        continue;
      }

      // --- Tool hooks ---

      if (hook === 'before_tool_call') {
        const toolName = payload.toolName ?? payload.tool_name ?? 'unknown';
        const turn: ReconstructedTurn = {
          role: 'tool',
          content: toolName,
          timestamp: ev.eventTs,
          userId: lastExplicitUserId,
          userAttribution: lastExplicitUserId ? 'inferred' : 'unknown',
          toolCalls: [{
            id: payload.toolCallId ?? payload.tool_call_id ?? `tc-${pendingToolCalls.length}`,
            toolName,
            arguments: payload.params ?? payload.arguments ?? {},
            status: 'pending',
          }],
        };
        session.turns.push(turn);
        pendingToolCalls.push({ turn, toolName });
        lastAssistantTurn = undefined;
        continue;
      }

      if (hook === 'after_tool_call') {
        const toolName = payload.toolName ?? payload.tool_name ?? 'unknown';
        // Match by toolName sequence (LIFO for same name)
        let matched = false;
        for (let i = pendingToolCalls.length - 1; i >= 0; i--) {
          if (pendingToolCalls[i].toolName === toolName) {
            const tc = pendingToolCalls[i].turn.toolCalls?.[0];
            if (tc) {
              tc.result = payload.result;
              tc.error = payload.error ? String(payload.error) : undefined;
              tc.status = payload.error ? 'error' : 'success';
              tc.durationMs = payload.durationMs ?? payload.duration_ms;
            }
            pendingToolCalls.splice(i, 1);
            matched = true;
            break;
          }
        }
        if (!matched) {
          // Orphan after_tool_call — create standalone turn
          session.turns.push({
            role: 'tool',
            content: toolName,
            timestamp: ev.eventTs,
            userId: lastExplicitUserId,
            userAttribution: lastExplicitUserId ? 'inferred' : 'unknown',
            toolCalls: [{
              id: payload.toolCallId ?? payload.tool_call_id ?? 'unknown',
              toolName,
              arguments: {},
              result: payload.result,
              error: payload.error ? String(payload.error) : undefined,
              status: payload.error ? 'error' : 'success',
              durationMs: payload.durationMs ?? payload.duration_ms,
            }],
          });
        }
        lastAssistantTurn = undefined;
        continue;
      }

      if (hook === 'tool_result_persist') {
        const content = extractContent(payload);
        const toolCallId = payload.toolCallId ?? payload.tool_call_id;
        session.turns.push({
          role: 'tool',
          content,
          toolCallId,
          userId: lastExplicitUserId,
          userAttribution: lastExplicitUserId ? 'inferred' : 'unknown',
          timestamp: ev.eventTs,
        });
        lastAssistantTurn = undefined;
        continue;
      }

      // --- Skipped hooks (saved to JSONL, no turn) ---

      if (SKIPPED_HOOKS.has(hook)) {
        continue;
      }

      // --- System lifecycle hooks ---

      if (hook === 'before_prompt_build' || hook === 'before_compaction' || hook === 'after_compaction' ||
          hook === 'before_reset' || hook === 'subagent_spawned' || hook === 'subagent_ended' ||
          hook === 'gateway_start' || hook === 'gateway_stop' ||
          hook === 'agent:bootstrap' || hook === 'gateway:startup') {
        session.turns.push({
          role: 'system',
          content: extractContent(payload) ?? hook,
          timestamp: ev.eventTs,
          userAttribution: 'unknown',
        });
        lastAssistantTurn = undefined;
        continue;
      }

      // Unrecognized hooks — system turns for traceability
      session.turns.push({
        role: 'system',
        content: hook,
        timestamp: ev.eventTs,
        userAttribution: 'unknown',
      });
      lastAssistantTurn = undefined;
    }

    return session;
  }
}

// --- Helpers ---

function extractContent(payload: any): string | undefined {
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.context?.content === 'string') return payload.context.content;
  if (typeof payload.messages?.[0]?.content === 'string') return payload.messages[0].content;
  if (typeof payload.message?.content === 'string') return payload.message.content;
  if (typeof payload.text === 'string') return payload.text;
  return undefined;
}
