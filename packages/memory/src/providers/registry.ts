import type { ProviderName } from '../types.js';

type AuthMode = 'queryKey' | 'bearer';

export interface ProviderConfig {
  name: ProviderName;
  apiKeyEnv: string;
  baseUrl: string;
  embedPath: string;   // may include :model
  extractPath: string; // may include :model
  defaultEmbedModel: string;
  defaultExtractModel: string;
  embedModelEnv?: string;
  extractModelEnv?: string;
  auth: AuthMode;
}

export const PROVIDERS: Record<ProviderName, ProviderConfig> = {
  gemini: {
    name: 'gemini',
    apiKeyEnv: 'GOOGLE_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    embedPath: 'models/:model:embedContent',
    extractPath: 'models/:model:generateContent',
    defaultEmbedModel: 'gemini-embedding-001',
    defaultExtractModel: 'gemini-2.5-flash',
    embedModelEnv: 'GEMINI_EMBED_MODEL',
    extractModelEnv: 'GEMINI_EXTRACT_MODEL',
    auth: 'queryKey',
  },
  openai: {
    name: 'openai',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    embedPath: 'embeddings',
    extractPath: 'chat/completions',
    defaultEmbedModel: 'text-embedding-3-small',
    defaultExtractModel: 'gpt-4o-mini',
    embedModelEnv: 'OPENAI_EMBED_MODEL',
    extractModelEnv: 'OPENAI_EXTRACT_MODEL',
    auth: 'bearer',
  },
  openrouter: {
    name: 'openrouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    embedPath: 'embeddings',
    extractPath: 'chat/completions',
    defaultEmbedModel: 'openai/text-embedding-3-small',
    defaultExtractModel: 'openai/gpt-4o-mini',
    embedModelEnv: 'OPENROUTER_EMBED_MODEL',
    extractModelEnv: 'OPENROUTER_EXTRACT_MODEL',
    auth: 'bearer',
  },
};

export function resolveProvider(kind: 'embed' | 'extract'): ProviderConfig {
  const env = (kind === 'embed' ? process.env.MEMORY_EMBED_PROVIDER : process.env.MEMORY_EXTRACT_PROVIDER)?.toLowerCase() as ProviderName | undefined;
  const selected: ProviderName = env === 'openai' ? 'openai' : env === 'openrouter' ? 'openrouter' : 'gemini';
  return PROVIDERS[selected];
}

export function getModel(cfg: ProviderConfig, kind: 'embed' | 'extract'): string {
  const envVar = kind === 'embed' ? cfg.embedModelEnv : cfg.extractModelEnv;
  const fallback = kind === 'embed' ? cfg.defaultEmbedModel : cfg.defaultExtractModel;
  return (envVar && process.env[envVar]) || fallback;
}

export function getApiKey(cfg: ProviderConfig): string {
  const key = process.env[cfg.apiKeyEnv];
  if (!key) {
    throw new Error(`${cfg.apiKeyEnv} is required for provider ${cfg.name}`);
  }
  return key;
}

export function buildUrl(cfg: ProviderConfig, kind: 'embed' | 'extract', model: string, apiKey: string): { url: string; headers: Record<string, string> } {
  const path = (kind === 'embed' ? cfg.embedPath : cfg.extractPath).replace(':model', model);
  const sep = cfg.baseUrl.endsWith('/') ? '' : '/';
  const base = `${cfg.baseUrl}${sep}${path}`;
  if (cfg.auth === 'queryKey') {
    return { url: `${base}?key=${apiKey}`, headers: { 'Content-Type': 'application/json' } };
  }
  return {
    url: base,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  };
}
