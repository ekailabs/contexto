import type { ContextoBackend, Logger, PluginConfig } from './types.js';
import { lastUserMessage } from './messages.js';
import { buildPayload } from './hooks.js';

const DEFAULT_MAX_CONTEXT_CHARS = 2000;
const DEFAULT_MAX_RESULTS = 10;

/** Estimate token count from messages using ~4 chars per token heuristic. */
function estimateTokens(messages: any[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Create the OpenClaw context engine that retrieves relevant past conversations via the backend. */
export function createContextEngine(config: PluginConfig, backend: ContextoBackend, logger: Logger) {
  let bufferedMessages: any[] = [];
  let lastSessionId: string = '';
  let lastSessionKey: string = '';
  let cachedTokenBudget: number | undefined;

  /** Ingest a set of messages to the backend and clear them from the buffer. */
  function ingestMessages(
    messages: any[],
    sessionId: string,
    sessionKey: string,
    fireAndForget: boolean,
  ): Promise<void> | undefined {
    if (messages.length === 0) return;

    const userMessages = messages.filter((m: any) => m.role === 'user');
    const assistantMessages = messages.filter((m: any) => m.role === 'assistant');
    const toolMessages = messages.filter((m: any) => m.role === 'tool');

    const payload = buildPayload('episode', 'combined', sessionKey, {
      sessionId,
    }, undefined, {
      userMessage: userMessages[0] ?? null,
      assistantMessages,
      toolMessages,
    });

    const promise = backend.ingest(payload);

    if (fireAndForget) {
      promise.catch((err: unknown) => {
        logger.warn(`[contexto] ingestion failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }

    return promise;
  }

  return {
    info: {
      id: 'contexto',
      name: 'Contexto',
      ownsCompaction: true,
    },

    async bootstrap(_params: { sessionId: string; sessionFile: string; sessionKey?: string }) {
      return { bootstrapped: false, importedMessages: 0, reason: 'not applicable' };
    },

    async ingest(_params: { sessionId: string; sessionKey?: string; message: any; isHeartbeat?: boolean }) {
      return { ingested: false };
    },

    async ingestBatch(_params: { sessionId: string; sessionKey?: string; messages: any[]; isHeartbeat?: boolean }) {
      return { ingestedCount: 0 };
    },

    async afterTurn(params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      messages: any[];
      prePromptMessageCount: number;
      isHeartbeat?: boolean;
      runtimeContext?: Record<string, unknown>;
    }) {
      if (!config.apiKey) return;

      const newMessages = params.messages.slice(params.prePromptMessageCount);
      if (newMessages.length === 0) return;

      lastSessionId = params.sessionId;
      lastSessionKey = params.sessionKey || params.sessionId;

      // Buffer new messages — ingestion happens on compact() (threshold-based) or dispose()
      bufferedMessages.push(...newMessages);
      logger.info(`[contexto] afterTurn: buffered ${newMessages.length} messages (total: ${bufferedMessages.length})`);
    },

    async assemble(params: { sessionId: string; sessionKey?: string; messages: any[]; tokenBudget?: number }) {
      const { messages, tokenBudget } = params;

      // Cache tokenBudget for threshold evaluation in compact()
      if (tokenBudget != null) cachedTokenBudget = tokenBudget;

      const lastMsg = messages?.[messages.length - 1];
      logger.info(`[contexto] assemble() called — ${messages?.length} messages, tokenBudget: ${tokenBudget}, contextEnabled: ${config.contextEnabled}, hasApiKey: ${!!config.apiKey}`);
      logger.debug(`[contexto] last message — role: ${lastMsg?.role}, content type: ${typeof lastMsg?.content}, isArray: ${Array.isArray(lastMsg?.content)}, sample: ${JSON.stringify(lastMsg?.content)?.slice(0, 200)}`);

      if (!config.apiKey || !config.contextEnabled) {
        logger.info(`[contexto] assemble() skipping — apiKey: ${!!config.apiKey}, contextEnabled: ${config.contextEnabled}`);
        return { messages, estimatedTokens: 0 };
      }

      const query = lastUserMessage(messages);
      if (!query) {
        return { messages, estimatedTokens: 0 };
      }

      const maxChars = tokenBudget
        ? Math.floor(tokenBudget * 0.1 * 4)
        : (config.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS);

      logger.info(`[contexto] Fetching context for query: "${query.slice(0, 100)}"`);
      const searchKey = params.sessionKey || params.sessionId;
      const filter = { source: 'summary', ...config.filter };
      const result = await backend.search(query, searchKey, DEFAULT_MAX_RESULTS, filter);

      if (!result?.items?.length) {
        return { messages, estimatedTokens: 0 };
      }

      const itemSummary = result.items.map((r: any, i: number) => `[${i}] ${r.item?.content?.length ?? 0} chars`).join(', ');
      logger.info(`[contexto] Mindmap returned ${result.items.length} items (${itemSummary}), paths: ${JSON.stringify(result.paths)}`);

      let context = result.items
        .map((r: any) => {
          const item = r.item ?? r;
          const meta = item.metadata ?? {};

          if (meta.source !== 'summary') {
            return `- ${item.content}`;
          }

          // content already has: "summary\n\nKey findings:\n- finding1\n- finding2"
          const parts: string[] = [item.content];

          if (Array.isArray(meta.evidence_refs) && meta.evidence_refs.length > 0) {
            const refs = meta.evidence_refs
              .map((ref: any) => `${ref.type}:${ref.value}`)
              .join(', ');
            parts.push(`Refs: ${refs}`);
          }

          if (meta.trace_ref) {
            parts.push(`Trace: ${meta.trace_ref}`);
          }

          const header = [meta.status, meta.confidence != null ? `confidence: ${meta.confidence}` : null]
            .filter(Boolean).join(' | ');

          const body = parts.join('\n');
          return header ? `### [${header}]\n${body}` : body;
        })
        .join('\n\n');
      context = `## Relevant Context\n\n${context}`;

      if (context.length > maxChars) {
        context = context.slice(0, maxChars) + '…';
      }

      logger.info(`[contexto] Injecting ${context.length} chars of context`);

      const assembled = [
        { role: 'user', content: [{ type: 'text', text: '[Recalled context from previous conversations]' }] },
        { role: 'assistant', content: [{ type: 'text', text: context }] },
        ...messages,
      ];

      return { messages: assembled, estimatedTokens: Math.ceil(context.length / 4) };
    },

    async compact(params: {
      sessionId: string;
      sessionKey?: string;
      sessionFile: string;
      tokenBudget?: number;
      currentTokenCount?: number;
      compactionTarget?: 'budget' | 'threshold';
      customInstructions?: string;
      runtimeContext?: Record<string, unknown>;
      legacyParams?: Record<string, unknown>;
      force?: boolean;
    }) {
      // Cache tokenBudget for future reference
      if (params.tokenBudget != null) cachedTokenBudget = params.tokenBudget;

      const tokenBudget = params.tokenBudget ?? cachedTokenBudget;
      if (!config.apiKey || !tokenBudget || bufferedMessages.length === 0) {
        return { ok: true, compacted: false, reason: 'nothing to compact' };
      }

      // Evaluate threshold: trigger compaction when context usage exceeds contextThreshold
      const thresholdPct = config.contextThreshold ?? 0.75;
      const threshold = Math.floor(thresholdPct * tokenBudget);
      const currentTokens = params.currentTokenCount ?? estimateTokens(bufferedMessages);

      if (currentTokens <= threshold && !params.force) {
        return { ok: true, compacted: false, reason: 'below threshold' };
      }

      // Calculate how many tokens to free: bring usage down to compactionTarget
      const targetPct = config.compactionTarget ?? 0.50;
      const target = Math.floor(targetPct * tokenBudget);
      const tokensToFree = currentTokens - target;

      // Evict oldest messages until we've freed enough tokens
      let freedTokens = 0;
      let evictCount = 0;
      for (let i = 0; i < bufferedMessages.length && freedTokens < tokensToFree; i++) {
        freedTokens += estimateTokens([bufferedMessages[i]]);
        evictCount++;
      }

      const evicted = bufferedMessages.slice(0, evictCount);
      const kept = bufferedMessages.slice(evictCount);

      // Determine firstKeptEntryId from the first kept message (if available)
      const firstKept = kept.length > 0 ? kept[0] : null;
      const firstKeptEntryId = firstKept?.id ?? firstKept?.entryId ?? undefined;

      const sessionKey = params.sessionKey || params.sessionId;
      logger.info(
        `[contexto] compact: evicting ${evictCount} messages (${freedTokens} tokens), ` +
        `keeping ${kept.length}, threshold: ${threshold}, current: ${currentTokens}, target: ${target}`,
      );

      // Ingest evicted messages to mindmap
      await ingestMessages(evicted, params.sessionId, sessionKey, false);

      // Update buffer to only kept messages
      bufferedMessages = kept;

      return {
        ok: true,
        compacted: true,
        reason: 'threshold',
        result: {
          firstKeptEntryId,
          tokensBefore: currentTokens,
          tokensAfter: currentTokens - freedTokens,
        },
      };
    },

    async prepareSubagentSpawn(_params: { parentSessionKey: string; childSessionKey: string; ttlMs?: number }) {
      return undefined;
    },

    async onSubagentEnded(_params: { childSessionKey: string; reason: string }) {},

    async dispose() {
      if (!config.apiKey || bufferedMessages.length === 0) return;

      logger.info(`[contexto] dispose: ingesting ${bufferedMessages.length} remaining buffered messages`);
      await ingestMessages(bufferedMessages, lastSessionId, lastSessionKey, false);
      bufferedMessages = [];
    },
  };
}
