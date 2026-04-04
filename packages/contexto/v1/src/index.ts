import type { PluginConfig } from './types.js';
import { RemoteBackend } from './client.js';
import { createContextEngine } from './engine/index.js';

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
    },
  },

  register(api: any) {
    const strategy = api.pluginConfig?.compactionStrategy ?? 'default';
    const base = {
      apiKey: api.pluginConfig?.apiKey,
      contextEnabled: api.pluginConfig?.contextEnabled ?? true,
      maxContextChars: api.pluginConfig?.maxContextChars,
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

    const engine = createContextEngine(config, backend, logger);

    (api as unknown as {
      registerContextEngine: (id: string, factory: () => typeof engine) => void;
    }).registerContextEngine('contexto', () => engine);

    logger.info(`[contexto] Plugin registered (contextEnabled: ${config.contextEnabled})`);
  },
};
