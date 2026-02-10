import { AIProvider } from '../types/provider.js';
import { AnthropicProvider } from '../providers/anthropic-provider.js';
import { OpenAIProvider } from '../providers/openai-provider.js';
import { OpenRouterProvider } from '../providers/openrouter-provider.js';
import { XAIProvider } from '../providers/xai-provider.js';
import { ZAIProvider } from '../providers/zai-provider.js';
import { GoogleProvider } from '../providers/google-provider.js';
import { OllamaProvider } from '../providers/ollama-provider.js';

export enum Provider {
  ANTHROPIC = 'anthropic',
  OPENAI = 'openai',
  OPENROUTER = 'openrouter',
  XAI = 'xAI',
  ZAI = 'zai',
  GOOGLE = 'google',
  OLLAMA = 'ollama'
}

export interface ProviderSelectionRule {
  match: (modelName: string) => boolean;
}

export interface ProviderPlugin {
  id: Provider;
  create: () => AIProvider;
  selectionRules?: ProviderSelectionRule[];
}

/**
  * Central registry for provider creation and selection hints.
  * Keeps wiring in one place and reduces per-provider boilerplate.
  */
export class ProviderRegistry {
  private readonly instances = new Map<Provider, AIProvider>();

  constructor(private readonly plugins: ProviderPlugin[]) {}

  listProviders(): Provider[] {
    return this.plugins.map(p => p.id);
  }

  getOrCreateProvider(id: Provider): AIProvider {
    if (!this.instances.has(id)) {
      const plugin = this.plugins.find(p => p.id === id);
      if (!plugin) {
        throw new Error(`Unknown provider: ${id}`);
      }
      this.instances.set(id, plugin.create());
    }

    const provider = this.instances.get(id);
    if (!provider) {
      throw new Error(`Failed to create provider: ${id}`);
    }
    return provider;
  }

  getAvailableProviders(): Provider[] {
    return this.listProviders().filter(id => {
      const provider = this.getOrCreateProvider(id);
      return provider.isConfigured();
    });
  }

  /**
   * Return the first preferred provider whose rule matches the model name and is available.
   */
  findPreferredProvider(modelName: string, available: Provider[]): Provider | undefined {
    for (const plugin of this.plugins) {
      if (!plugin.selectionRules || !available.includes(plugin.id)) continue;
      if (plugin.selectionRules.some(rule => rule.match(modelName))) {
        return plugin.id;
      }
    }
    return undefined;
  }
}

export function createDefaultProviderRegistry(): ProviderRegistry {
  const plugins: ProviderPlugin[] = [
    { id: Provider.ANTHROPIC, create: () => new AnthropicProvider() },
    { id: Provider.OPENAI, create: () => new OpenAIProvider() },
    { id: Provider.OPENROUTER, create: () => new OpenRouterProvider() },
    { id: Provider.XAI, create: () => new XAIProvider(), selectionRules: [{ match: model => model.includes('grok-') || model.includes('grok_beta') }] },
    { id: Provider.ZAI, create: () => new ZAIProvider() },
    { id: Provider.GOOGLE, create: () => new GoogleProvider(), selectionRules: [{ match: model => model.toLowerCase().includes('gemini') }] },
    { id: Provider.OLLAMA, create: () => new OllamaProvider(), selectionRules: [{ match: model => model.startsWith('ollama/') }] },
  ];

  return new ProviderRegistry(plugins);
}
