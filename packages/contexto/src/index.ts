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

      maxContextChars: { type: 'number' },
      compactThreshold: { type: 'number', default: 0.50 },
      compactionStrategy: { type: 'string', default: 'default' },
      mode: { type: 'string', default: 'remote' },
    },
  },

  register(api: any) {
    const strategy = api.pluginConfig?.compactionStrategy ?? 'default';
    const backendMode = api.pluginConfig?.mode ?? 'remote';

    const base = {
      apiKey: api.pluginConfig?.apiKey,
      maxContextChars: api.pluginConfig?.maxContextChars,
      mode: backendMode as 'remote' | 'local',
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
      const modelAuth = api.runtime?.modelAuth;
      if (!modelAuth?.resolveApiKeyForProvider) {
        logger.warn('[contexto] Local mode requires modelAuth — not available');
        return;
      }

      // Resolve API key via .then() since register() must be synchronous
      modelAuth.resolveApiKeyForProvider({ provider: 'openrouter', cfg: api.config })
        .then((openrouterAuth: any) => {
          if (openrouterAuth?.apiKey) {
            return { provider: 'openrouter' as const, apiKey: openrouterAuth.apiKey };
          }
          return modelAuth.resolveApiKeyForProvider({ provider: 'openai', cfg: api.config })
            .then((openaiAuth: any) => {
              if (openaiAuth?.apiKey) {
                return { provider: 'openai' as const, apiKey: openaiAuth.apiKey };
              }
              return null;
            });
        })
        .then((result: { provider: 'openrouter' | 'openai'; apiKey: string } | null) => {
          if (!result) {
            logger.warn('[contexto] Local mode requires an OpenRouter or OpenAI API key configured in OpenClaw');
            return;
          }
          config.apiKey = 'local';
          const backend = new LocalBackend({ provider: result.provider, apiKey: result.apiKey }, logger);
          const engine = createContextEngine(config, backend, logger);
          api.registerContextEngine('contexto', () => engine);
          logger.info(`[contexto] Plugin registered with local backend (provider: ${result.provider})`);
        })
        .catch((err: any) => {
          logger.warn(`[contexto] Failed to resolve API key: ${err?.message ?? err}`);
        });
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
    logger.info('[contexto] Plugin registered');
  },
};
