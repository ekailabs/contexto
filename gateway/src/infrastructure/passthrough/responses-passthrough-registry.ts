import { ResponsesPassthrough, ResponsesPassthroughConfig } from './responses-passthrough.js';
import { OpenAIResponsesPassthrough } from './openai-responses-passthrough.js';
import { OllamaResponsesPassthrough } from './ollama-responses-passthrough.js';
import { XAIResponsesPassthrough } from './xai-responses-passthrough.js';
import { loadResponsesProviderDefinitions, ResponsesProviderDefinition } from './responses-provider-config.js';
import { logger } from '../utils/logger.js';

interface ProviderEntry {
  definition: ResponsesProviderDefinition;
  passthrough?: ResponsesPassthrough;
}

const passthroughFactories: Record<string, (config: ResponsesPassthroughConfig) => ResponsesPassthrough> = {
  openai: (config) => new OpenAIResponsesPassthrough(config),
  xai: (config) => new XAIResponsesPassthrough(config),
  ollama: (config) => new OllamaResponsesPassthrough(config),
};

export class ResponsesPassthroughRegistry {
  private readonly providers = new Map<string, ProviderEntry>();

  constructor(definitions: ResponsesProviderDefinition[]) {
    definitions.forEach(definition => {
      if (!passthroughFactories[definition.provider]) {
        logger.warn('No responses passthrough factory registered for provider', {
          provider: definition.provider,
          module: 'responses-passthrough-registry',
        });
        return;
      }
      this.providers.set(definition.provider, { definition });
    });
  }

  listProviders(): string[] {
    return Array.from(this.providers.keys());
  }

  getSupportedClientFormats(provider: string): string[] {
    const entry = this.providers.get(provider);
    return entry?.definition.config.supportedClientFormats ?? [];
  }

  getConfig(provider: string): ResponsesPassthroughConfig | undefined {
    const entry = this.providers.get(provider);
    return entry?.definition.config;
  }

  getPassthrough(provider: string): ResponsesPassthrough | undefined {
    const entry = this.providers.get(provider);
    if (!entry) return undefined;

    if (!entry.passthrough) {
      const factory = passthroughFactories[entry.definition.provider];
      if (!factory) return undefined;
      entry.passthrough = factory(entry.definition.config);
      this.providers.set(provider, entry);
    }

    return entry.passthrough;
  }
}

export function createResponsesPassthroughRegistry(): ResponsesPassthroughRegistry {
  const definitions = loadResponsesProviderDefinitions();
  return new ResponsesPassthroughRegistry(definitions);
}
