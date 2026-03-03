import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sanitizeId } from './types.js';
import type { StoreEvent, ReconstructedSession, ReconstructedTurn, ReconstructedToolCall } from './types.js';

export class EventReader {
  constructor(private dataDir: string) {}

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
  private resolveAgent(agentId: string): string {
    const candidatePath = join(this.dataDir, agentId);
    if (this.isInsideDataDir(candidatePath) && existsSync(candidatePath)) return agentId;
    return sanitizeId(agentId, 'agent');
  }

  /**
   * Resolve a sessionId to its file stem.
   * Accepts both raw IDs and already-sanitized IDs (from listSessions output).
   */
  private resolveSession(agentDir: string, sessionId: string): string {
    const candidatePath = join(this.dataDir, agentDir, `${sessionId}.jsonl`);
    if (this.isInsideDataDir(candidatePath) && existsSync(candidatePath)) return sessionId;
    return sanitizeId(sessionId, 'session');
  }

  /** List all agent directories, sorted lexically. */
  listAgents(): string[] {
    try {
      const entries = readdirSync(this.dataDir, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** List sessions for an agent, sorted by mtime (newest first). Accepts raw or sanitized agentId. */
  listSessions(agentId: string): string[] {
    const resolved = this.resolveAgent(agentId);
    const dir = join(this.dataDir, resolved);
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      const sessions = entries
        .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
        .map(e => {
          const name = e.name.replace(/\.jsonl$/, '');
          const mtime = statSync(join(dir, e.name)).mtimeMs;
          return { name, mtime };
        });
      sessions.sort((a, b) => b.mtime - a.mtime);
      return sessions.map(s => s.name);
    } catch {
      return [];
    }
  }

  /** Read all events from a session JSONL file. Accepts raw or sanitized IDs. Skips malformed lines. */
  readSession(agentId: string, sessionId: string, opts?: { dedupe?: boolean }): StoreEvent[] {
    const resolvedAgent = this.resolveAgent(agentId);
    const resolvedSession = this.resolveSession(resolvedAgent, sessionId);
    const filePath = join(this.dataDir, resolvedAgent, `${resolvedSession}.jsonl`);

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
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

  /** Reconstruct a session from events into ordered turns with tool call pairing. */
  reconstructSession(agentId: string, sessionId: string): ReconstructedSession {
    const events = this.readSession(agentId, sessionId);
    const resolvedAgent = this.resolveAgent(agentId);
    const resolvedSession = this.resolveSession(resolvedAgent, sessionId);

    // Sort by eventTs for chronological reconstruction
    events.sort((a, b) => a.eventTs - b.eventTs);

    const session: ReconstructedSession = {
      sessionId: resolvedSession,
      agentId: resolvedAgent,
      startedAt: events.length > 0 ? events[0].eventTs : 0,
      turns: [],
    };

    // Track pending tool calls for pairing.
    // Each entry tracks all its map keys so we can clean up all indexes on match.
    interface PendingToolEntry {
      turn: ReconstructedTurn;
      call: ReconstructedToolCall;
      ts: number;
      mapKeys: string[];
    }
    const pendingToolCalls = new Map<string, PendingToolEntry>();
    // Sequence-based fallback: track before_tool_call by toolName order
    const beforeToolSequence: { toolName: string; entry: PendingToolEntry }[] = [];

    /** Remove a matched entry from ALL indexes. */
    function cleanupEntry(entry: PendingToolEntry): void {
      for (const key of entry.mapKeys) {
        pendingToolCalls.delete(key);
      }
      const seqIdx = beforeToolSequence.findIndex(e => e.entry === entry);
      if (seqIdx !== -1) beforeToolSequence.splice(seqIdx, 1);
    }

    // Track last explicit userId for inference
    let lastExplicitUserId: string | undefined;

    for (const ev of events) {
      const hook = ev.hook;
      const payload = ev.event ?? {};

      if (hook === 'session_start') {
        session.startedAt = ev.eventTs;
        continue;
      }

      if (hook === 'session_end') {
        session.endedAt = ev.eventTs;
        continue;
      }

      if (hook === 'message_received') {
        const role = resolveRole(payload, 'user');
        const content = extractContent(payload);
        const userId = ev.userId ?? payload.userId;
        if (userId) lastExplicitUserId = userId;

        session.turns.push({
          role,
          content,
          userId,
          userAttribution: userId ? 'explicit' : 'unknown',
          timestamp: ev.eventTs,
        });
        continue;
      }

      if (hook === 'llm_output') {
        const role = resolveRole(payload, 'assistant');
        const content = payload.content ?? payload.message?.content;
        const model = payload.model ?? payload.message?.model;
        const inputTokens = payload.usage?.input_tokens ?? payload.usage?.prompt_tokens;
        const outputTokens = payload.usage?.output_tokens ?? payload.usage?.completion_tokens;

        // Extract tool calls from llm_output
        const rawToolCalls = payload.tool_calls ?? payload.message?.tool_calls ?? [];
        const toolCalls: ReconstructedToolCall[] = rawToolCalls.map((tc: any) => ({
          id: tc.id ?? randomId(),
          toolName: tc.function?.name ?? tc.name ?? 'unknown',
          arguments: tc.function?.arguments ? parseArgs(tc.function.arguments) : (tc.arguments ?? {}),
          status: 'pending' as const,
        }));

        const turn: ReconstructedTurn = {
          role,
          content: typeof content === 'string' ? content : undefined,
          model,
          userId: lastExplicitUserId,
          userAttribution: lastExplicitUserId ? 'inferred' : 'unknown',
          inputTokens,
          outputTokens,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: ev.eventTs,
        };
        session.turns.push(turn);
        continue;
      }

      if (hook === 'before_tool_call') {
        const toolCallId = payload.toolCallId ?? payload.tool_call_id;
        const runId = payload.runId ?? payload.run_id;
        const toolName = payload.toolName ?? payload.tool_name ?? payload.name ?? 'unknown';
        const args = payload.arguments ?? payload.args ?? {};

        const call: ReconstructedToolCall = {
          id: toolCallId ?? randomId(),
          toolName,
          arguments: typeof args === 'string' ? parseArgs(args) : args,
          status: 'pending',
        };

        const turn: ReconstructedTurn = {
          role: 'tool',
          toolCallId,
          userId: lastExplicitUserId,
          userAttribution: lastExplicitUserId ? 'inferred' : 'unknown',
          toolCalls: [call],
          timestamp: ev.eventTs,
        };

        // Register for pairing — track all keys for cleanup
        const entry: PendingToolEntry = { turn, call, ts: ev.eventTs, mapKeys: [] };
        if (toolCallId) {
          const key = `id:${toolCallId}`;
          pendingToolCalls.set(key, entry);
          entry.mapKeys.push(key);
        }
        if (runId && toolName) {
          const key = `run:${runId}:${toolName}`;
          pendingToolCalls.set(key, entry);
          entry.mapKeys.push(key);
        }
        beforeToolSequence.push({ toolName, entry });

        session.turns.push(turn);
        continue;
      }

      if (hook === 'after_tool_call') {
        const toolCallId = payload.toolCallId ?? payload.tool_call_id;
        const runId = payload.runId ?? payload.run_id;
        const toolName = payload.toolName ?? payload.tool_name ?? payload.name ?? 'unknown';
        const result = payload.result;
        const error = payload.error;
        const durationMs = payload.durationMs ?? payload.duration_ms;

        // Try to pair with a before_tool_call
        let matched: PendingToolEntry | undefined;

        // Priority 1: toolCallId exact match
        if (toolCallId && pendingToolCalls.has(`id:${toolCallId}`)) {
          matched = pendingToolCalls.get(`id:${toolCallId}`);
        }

        // Priority 2: runId + toolName match
        if (!matched && runId && toolName) {
          const key = `run:${runId}:${toolName}`;
          if (pendingToolCalls.has(key)) {
            matched = pendingToolCalls.get(key);
          }
        }

        // Priority 3: sequence-based (nth before paired with nth after for same tool name)
        if (!matched) {
          const seqMatch = beforeToolSequence.find(e => e.toolName === toolName);
          if (seqMatch) {
            matched = seqMatch.entry;
          }
        }

        if (matched) {
          // Clean up ALL indexes for this entry before applying result
          cleanupEntry(matched);

          matched.call.result = result;
          matched.call.error = typeof error === 'string' ? error : error?.message;
          matched.call.status = error ? 'error' : 'success';
          if (durationMs != null) matched.call.durationMs = durationMs;
          if (!durationMs && matched.ts) {
            matched.call.durationMs = ev.eventTs - matched.ts;
          }
        }
        // If no match, after_tool_call is orphaned — we don't create a turn for it
        continue;
      }

      if (hook === 'message_sent') {
        const role = resolveRole(payload, 'assistant');
        const content = extractContent(payload);
        session.turns.push({
          role,
          content,
          userId: lastExplicitUserId,
          userAttribution: lastExplicitUserId ? 'inferred' : 'unknown',
          timestamp: ev.eventTs,
        });
        continue;
      }

      // Other hooks (before_prompt_build, llm_input, tool_result_persist, agent_end,
      // before_compaction, after_compaction) — system turns for traceability
      session.turns.push({
        role: 'system',
        content: hook,
        timestamp: ev.eventTs,
        userAttribution: 'unknown',
      });
    }

    return session;
  }
}

// --- Helpers ---

function resolveRole(payload: any, fallback: 'user' | 'assistant'): 'user' | 'assistant' | 'system' | 'tool' {
  const role = payload.role ?? payload.from;
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'tool') return role;
  return fallback;
}

function extractContent(payload: any): string | undefined {
  if (typeof payload.content === 'string') return payload.content;
  if (typeof payload.message?.content === 'string') return payload.message.content;
  if (typeof payload.text === 'string') return payload.text;
  return undefined;
}

function parseArgs(args: unknown): Record<string, any> {
  if (typeof args === 'string') {
    try { return JSON.parse(args); } catch { return { _raw: args }; }
  }
  if (args && typeof args === 'object') return args as Record<string, any>;
  return {};
}

let _counter = 0;
function randomId(): string {
  return `_gen_${Date.now()}_${_counter++}`;
}
