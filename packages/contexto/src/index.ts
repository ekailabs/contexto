import type { PluginConfig } from './types.js';
import { RemoteBackend } from './client.js';
import { LocalBackend } from './local/index.js';
import type { ResolvedCredentials } from './local/index.js';
import { createContextEngine } from './engine/index.js';

export type { ContextoBackend, SearchResult, WebhookPayload, Logger } from './types.js';
export { RemoteBackend } from './client.js';
export { LocalBackend } from './local/index.js';
export type { LocalBackendConfig, ResolvedCredentials, EpisodeSummary } from './local/index.js';

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
      mode: { type: 'string', default: 'remote' },
    },
  },

  register(api: any) {
    const strategy = api.pluginConfig?.compactionStrategy ?? 'default';
    const backendMode = api.pluginConfig?.mode ?? 'remote';
    const logger = api.logger;

    const base = {
      apiKey: api.pluginConfig?.apiKey,
      contextEnabled: api.pluginConfig?.contextEnabled ?? true,
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

    if (backendMode === 'local') {
      const modelAuth = api.runtime?.modelAuth;
      if (!modelAuth?.resolveApiKeyForProvider) {
        logger.warn('[contexto] Local mode requires modelAuth — not available');
        return;
      }

      // Defer API key resolution to first ingest/search so registerContextEngine
      // is called synchronously here (OpenClaw does not wait for async work in register()).
      const resolveCredentials = async (): Promise<ResolvedCredentials | null> => {
        try {
          const openrouterAuth = await modelAuth.resolveApiKeyForProvider({ provider: 'openrouter', cfg: api.config });
          if (openrouterAuth?.apiKey) {
            return { provider: 'openrouter', apiKey: openrouterAuth.apiKey };
          }
          const openaiAuth = await modelAuth.resolveApiKeyForProvider({ provider: 'openai', cfg: api.config });
          if (openaiAuth?.apiKey) {
            return { provider: 'openai', apiKey: openaiAuth.apiKey };
          }
          logger.warn('[contexto] Local mode requires an OpenRouter or OpenAI API key configured in OpenClaw');
          return null;
        } catch (err: any) {
          logger.warn(`[contexto] Failed to resolve API key: ${err?.message ?? err}`);
          return null;
        }
      };

      // Sentinel apiKey so assemble()/afterTurn() guards pass; real credentials live in the backend.
      config.apiKey = 'local';
      const backend = new LocalBackend({ credentials: resolveCredentials }, logger);
      const engine = createContextEngine(config, backend, logger);
      api.registerContextEngine('contexto', () => engine);
      logger.info('[contexto] Plugin registered with local backend');
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
