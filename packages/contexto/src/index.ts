import type { PluginConfig } from './types.js';
import { RemoteBackend } from './client.js';
import { createContextEngine } from './engine/index.js';
import type { AbstractContextEngine } from './engine/base.js';

// Public API — use ContextoBackend to implement a custom (e.g. local) backend
export type { ContextoBackend, SearchResult, WebhookPayload, Logger } from './types.js';
export { RemoteBackend } from './client.js';

/** OpenClaw plugin definition. */
export default {
  id: 'contexto',
  name: 'Contexto',
  description: 'Context engine for OpenClaw with mindmap',

  configSchema: {
    type: 'object',
    properties: {
      apiKey: { type: 'string' },
      contextEnabled: { type: 'boolean', default: true },
      maxContextChars: { type: 'number' },
      compactThreshold: { type: 'number', default: 0.50 },
      compactionStrategy: { type: 'string', default: 'default' },
      rlmEnabled: { type: 'boolean', default: false },
    },
  },

  register(api: any) {
    const strategy = api.pluginConfig?.compactionStrategy ?? 'default';

    const base = {
      apiKey: api.pluginConfig?.apiKey,
      contextEnabled: api.pluginConfig?.contextEnabled ?? true,
      maxContextChars: api.pluginConfig?.maxContextChars,
      rlmEnabled: api.pluginConfig?.rlmEnabled ?? false,
    };

    const config: PluginConfig = strategy === 'default'
      ? { ...base, compactionStrategy: 'default' as const }
      : {
          ...base,
          compactionStrategy: 'sliding-window' as const,
          compactThreshold: api.pluginConfig?.compactThreshold ?? 0.50,
        };

    const logger = api.logger;

    if (!config.apiKey) {
      logger.warn('[contexto] Missing apiKey — ingestion and retrieval will be disabled');
      return;
    }

    const backend = new RemoteBackend(config, logger);

    const engine = createContextEngine(config, backend, logger) as AbstractContextEngine;

    api.registerContextEngine('contexto', () => engine);

    // --- RLM tool registration ---
    if (config.rlmEnabled) {
      registerRlmTools(api, engine, config, logger);
    }

    logger.info(`[contexto] Plugin registered (contextEnabled: ${config.contextEnabled}, rlm: ${config.rlmEnabled})`);
  },
};

/**
 * Register RLM tools with OpenClaw's tool registry.
 * Tools are available to all agents; handlers resolve the ContextBuffer
 * from the engine's pending context state.
 */
function registerRlmTools(api: any, engine: AbstractContextEngine, config: PluginConfig, logger: any) {
  // Lazy imports to avoid loading @ekai/rlm when RLM is not configured
  let rlmImports: any;
  let completionProvider: any;

  const ensureImports = async () => {
    if (rlmImports) return rlmImports;
    rlmImports = await import('@ekai/rlm');
    return rlmImports;
  };

  const RLM_PROVIDER = 'openrouter';
  const RLM_MODEL_ID = 'openrouter/auto';

  const ensureProvider = async () => {
    if (completionProvider) return completionProvider;
    const { createPiAiCompletionProvider } = await import('./rlm/adapter.js');
    const apiKey = await api.runtime?.modelAuth?.resolveApiKeyForProvider?.(RLM_PROVIDER)
      ?? config.apiKey;
    completionProvider = createPiAiCompletionProvider({
      provider: RLM_PROVIDER,
      modelId: RLM_MODEL_ID,
      apiKey,
    });
    return completionProvider;
  };

  // Session-keyed ContextBuffer instances
  const buffers = new Map<string, any>();

  const getOrCreateBuffer = async (sessionKey: string): Promise<any | null> => {
    if (buffers.has(sessionKey)) return buffers.get(sessionKey)!;

    const pending = engine.getPendingContext(sessionKey);
    if (!pending) return null;

    const rlm = await ensureImports();
    const buffer = new rlm.ContextBuffer(pending.content);
    buffers.set(sessionKey, buffer);
    return buffer;
  };

  // Tool definitions — registered eagerly so the agent sees them in tool lists
  const toolDefs = [
    {
      name: 'rlm_overview',
      description: 'Get structural overview of the loaded context — size, line count, detected sections, and a preview of the beginning',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'rlm_peek',
      description: 'View lines from the context at a given offset',
      parameters: {
        type: 'object',
        properties: {
          offset: { type: 'number', description: 'Line offset from start (0-indexed)' },
          length: { type: 'number', description: 'Number of lines to return (default: 50)' },
        },
        required: ['offset'],
      },
    },
    {
      name: 'rlm_grep',
      description: 'Search the context for a pattern (substring or regex)',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Search query or regex pattern' },
          regex: { type: 'boolean', description: 'Treat pattern as regex (default: false)' },
          limit: { type: 'number', description: 'Max results (default: 20)' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'rlm_slice',
      description: 'Extract a contiguous range of lines from the context',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'number', description: 'Start line (inclusive, 0-indexed)' },
          end: { type: 'number', description: 'End line (exclusive)' },
        },
        required: ['start', 'end'],
      },
    },
    {
      name: 'rlm_query',
      description: 'Ask a question about a portion of the context — dispatches to a sub-LLM with the relevant chunk',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Question to answer from context' },
          start: { type: 'number', description: 'Start line of chunk to analyze (default: 0)' },
          end: { type: 'number', description: 'End line of chunk (default: entire context up to budget)' },
        },
        required: ['question'],
      },
    },
    {
      name: 'rlm_repl',
      description: 'Run JavaScript in a sandboxed REPL with access to the full context, all retrieval functions (peek, grep, slice, llm_query), and variable persistence (store/get). Use FINAL(answer) or FINAL_VAR(name) to return results.',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'JavaScript code to execute in the sandbox' },
        },
        required: ['code'],
      },
    },
  ];

  // Handler map — each tool resolves the buffer from the session context
  const handlers: Record<string, (params: any, context: any) => Promise<any>> = {
    rlm_overview: async (_params, ctx) => {
      const buffer = await getOrCreateBuffer(ctx?.sessionKey ?? 'default');
      if (!buffer) return { content: 'No large context loaded for this session.' };
      const rlm = await ensureImports();
      const handler = rlm.createOverviewHandler(buffer);
      return { content: JSON.stringify(await handler(_params)) };
    },
    rlm_peek: async (params, ctx) => {
      const buffer = await getOrCreateBuffer(ctx?.sessionKey ?? 'default');
      if (!buffer) return { content: 'No large context loaded for this session.' };
      const rlm = await ensureImports();
      const handler = rlm.createPeekHandler(buffer);
      return { content: await handler(params) };
    },
    rlm_grep: async (params, ctx) => {
      const buffer = await getOrCreateBuffer(ctx?.sessionKey ?? 'default');
      if (!buffer) return { content: 'No large context loaded for this session.' };
      const rlm = await ensureImports();
      const handler = rlm.createGrepHandler(buffer);
      return { content: JSON.stringify(await handler(params)) };
    },
    rlm_slice: async (params, ctx) => {
      const buffer = await getOrCreateBuffer(ctx?.sessionKey ?? 'default');
      if (!buffer) return { content: 'No large context loaded for this session.' };
      const rlm = await ensureImports();
      const handler = rlm.createSliceHandler(buffer);
      return { content: await handler(params) };
    },
    rlm_query: async (params, ctx) => {
      const buffer = await getOrCreateBuffer(ctx?.sessionKey ?? 'default');
      if (!buffer) return { content: 'No large context loaded for this session.' };
      const rlm = await ensureImports();
      const provider = await ensureProvider();
      const handler = rlm.createQueryHandler(buffer, provider);
      return { content: await handler(params) };
    },
    rlm_repl: async (params, ctx) => {
      const buffer = await getOrCreateBuffer(ctx?.sessionKey ?? 'default');
      if (!buffer) return { content: 'No large context loaded for this session.' };
      const rlm = await ensureImports();
      const provider = await ensureProvider();
      const handler = rlm.createReplHandler(buffer, provider);
      return { content: JSON.stringify(await handler(params)) };
    },
  };

  // Register each tool with OpenClaw
  for (const def of toolDefs) {
    api.registerTool(def.name, {
      ...def,
      execute: async (params: any, context?: any) => {
        const sessionKey = context?.sessionKey ?? 'default';
        logger.info(`[contexto:rlm] Tool ${def.name} called for session ${sessionKey}`);
        try {
          return await handlers[def.name](params, context);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`[contexto:rlm] Tool ${def.name} failed: ${msg}`);
          return { content: `Error: ${msg}` };
        }
      },
    });
  }

  logger.info(`[contexto:rlm] Registered ${toolDefs.length} RLM tools (provider: ${RLM_PROVIDER}, model: ${RLM_MODEL_ID})`);
}
