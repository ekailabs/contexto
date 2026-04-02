import type { PluginConfig } from './types.js';
import { RemoteBackend } from './client.js';
import { registerHooks } from './hooks.js';
import { createContextEngine } from './engine.js';

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
      contextEnabled: { type: 'boolean', default: false },
      maxContextChars: { type: 'number' },
    },
  },

  register(api: any) {
    const config: PluginConfig = {
      apiKey: api.pluginConfig?.apiKey,
      contextEnabled: api.pluginConfig?.contextEnabled ?? false,
      maxContextChars: api.pluginConfig?.maxContextChars,
    };

    const logger = api.logger;

    if (!config.apiKey) {
      logger.warn('[contexto] Missing apiKey — ingestion and retrieval will be disabled');
      return;
    }

    const backend = new RemoteBackend(config, logger);

    registerHooks(api, backend, logger);

    const engine = createContextEngine(config, backend, logger);

    (api as unknown as {
      registerContextEngine: (id: string, factory: () => typeof engine) => void;
    }).registerContextEngine('contexto', () => engine);

    logger.info(`[contexto] Plugin registered (contextEnabled: ${config.contextEnabled})`);
  },
};
