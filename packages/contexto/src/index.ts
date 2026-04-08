import type { PluginConfig } from './types.js';
import { RemoteBackend } from './client.js';
import { LocalBackend } from './local/index.js';
import { createContextEngine } from './engine/index.js';

export type { ContextoBackend, SearchResult, WebhookPayload, Logger } from './types.js';
export { RemoteBackend } from './client.js';
export { LocalBackend } from './local/index.js';
export type { LocalBackendConfig, EpisodeSummary } from './local/index.js';

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
      backend: { type: 'string', default: 'remote' },
    },
  },

  register(api: any) {
    const strategy = api.pluginConfig?.compactionStrategy ?? 'default';
    const backendMode = api.pluginConfig?.backend ?? 'remote';

    const base = {
      apiKey: api.pluginConfig?.apiKey,
      contextEnabled: api.pluginConfig?.contextEnabled ?? true,
      maxContextChars: api.pluginConfig?.maxContextChars,
      backend: backendMode as 'remote' | 'local',
    };

    const config: PluginConfig = strategy === 'default'
      ? { ...base, compactionStrategy: 'default' as const }
      : {
          ...base,
          compactionStrategy: 'sliding-window' as const,
          compactThreshold: api.pluginConfig?.compactThreshold ?? 0.50,
        };

    const logger = api.logger;

    if (backendMode === 'local') {
      // Resolve provider and apiKey from OpenClaw runtime defaults
      const defaults = api.runtime?.agent?.defaults;
      const provider = defaults?.provider ?? 'openrouter';
      const apiKey = api.pluginConfig?.apiKey ?? defaults?.apiKey;

      if (!apiKey) {
        // Try resolving from runtime modelAuth as fallback
        logger.warn('[contexto] No apiKey available for local backend — provide apiKey in plugin config or ensure OpenClaw runtime has a configured provider');
        return;
      }

      // Set apiKey to a truthy value so engine guards (if (!this.config.apiKey)) pass
      config.apiKey = config.apiKey || 'local';

      const backend = new LocalBackend({
        provider,
        apiKey,
      }, logger);

      const engine = createContextEngine(config, backend, logger);
      api.registerContextEngine('contexto', () => engine);
      logger.info(`[contexto] Plugin registered with local backend (provider: ${provider}, contextEnabled: ${config.contextEnabled})`);
      return;
    }

    // Remote backend (default)
    if (!config.apiKey) {
      logger.warn('[contexto] Missing apiKey — ingestion and retrieval will be disabled');
      return;
    }

    const backend = new RemoteBackend(config, logger);

    const engine = createContextEngine(config, backend, logger);

    api.registerContextEngine('contexto', () => engine);

    logger.info(`[contexto] Plugin registered (contextEnabled: ${config.contextEnabled})`);
  },
};
