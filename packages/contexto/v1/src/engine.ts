import type { ContextoBackend, Logger, PluginConfig } from './types.js';
import { lastUserMessage } from './messages.js';
import { buildPayload } from './hooks.js';

const DEFAULT_MAX_CONTEXT_CHARS = 2000;
const DEFAULT_MAX_RESULTS = 10;

/** Create the OpenClaw context engine that retrieves relevant past conversations via the backend. */
export function createContextEngine(config: PluginConfig, backend: ContextoBackend, logger: Logger) {
  return {
    info: {
      id: 'contexto',
      name: 'Contexto',
      ownsCompaction: false,
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
    }) {
      if (!config.apiKey) return;

      const newMessages = params.messages.slice(params.prePromptMessageCount);
      if (newMessages.length === 0) return;

      const userMessage = newMessages.find((m: any) => m.role === 'user') ?? null;
      const assistantMessages = newMessages.filter((m: any) => m.role === 'assistant');
      const toolMessages = newMessages.filter((m: any) => m.role === 'tool');

      if (!userMessage && assistantMessages.length === 0) return;

      const sessionKey = params.sessionKey || params.sessionId;
      const payload = buildPayload('episode', 'combined', sessionKey, {}, undefined, {
        userMessage,
        assistantMessages,
        toolMessages,
      });

      logger.info(`[contexto] afterTurn: ingesting episode — user: ${!!userMessage}, assistant: ${assistantMessages.length}, tool: ${toolMessages.length}`);
      backend.ingest(payload);
    },

    async assemble(params: { sessionId: string; sessionKey?: string; messages: any[]; tokenBudget?: number }) {
      const { messages, tokenBudget } = params;
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
      const result = await backend.search(query, searchKey, DEFAULT_MAX_RESULTS, config.sourceFilter);

      if (!result?.items?.length) {
        return { messages, estimatedTokens: 0 };
      }

      const itemSummary = result.items.map((r: any, i: number) => `[${i}] ${r.item?.content?.length ?? 0} chars`).join(', ');
      logger.info(`[contexto] Mindmap returned ${result.items.length} items (${itemSummary}), paths: ${JSON.stringify(result.paths)}`);

      let context = result.items
        .map((r: any) => `- ${r.item?.content ?? r.content}`)
        .join('\n');
      context = `## Relevant Context\n${context}`;

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

    async compact(_params: {
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
      return { ok: true, compacted: false, reason: 'delegated to runtime' };
    },

    async prepareSubagentSpawn(_params: { parentSessionKey: string; childSessionKey: string; ttlMs?: number }) {
      return undefined;
    },

    async onSubagentEnded(_params: { childSessionKey: string; reason: string }) {},

    async dispose() {},
  };
}
