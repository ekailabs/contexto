import type { EmbedFn } from './types.js';

export type EmbedProvider = 'openrouter' | 'openai' | 'gemini';

export interface EmbedConfig {
  provider: EmbedProvider;
  apiKey: string;
  model?: string;
}

interface ProviderDef {
  baseUrl: string;
  path: string;
  defaultModel: string;
  auth: 'bearer' | 'queryKey';
}

const PROVIDERS: Record<EmbedProvider, ProviderDef> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    path: 'embeddings',
    defaultModel: 'openai/text-embedding-3-small',
    auth: 'bearer',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    path: 'embeddings',
    defaultModel: 'text-embedding-3-small',
    auth: 'bearer',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    path: 'models/:model:embedContent',
    defaultModel: 'gemini-embedding-001',
    auth: 'queryKey',
  },
};

export function createEmbedFn(config: EmbedConfig): EmbedFn {
  const def = PROVIDERS[config.provider];
  const model = config.model ?? def.defaultModel;
  const apiKey = config.apiKey;

  return async (text: string): Promise<number[]> => {
    const path = def.path.replace(':model', model);
    const base = `${def.baseUrl}/${path}`;

    const url = def.auth === 'queryKey' ? `${base}?key=${apiKey}` : base;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (def.auth === 'bearer') {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const body =
      config.provider === 'gemini'
        ? { model, content: { parts: [{ text }] } }
        : { model, input: text };

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '(no body)');
      throw new Error(`${config.provider} embed failed: ${resp.status} ${errBody}`);
    }

    if (config.provider === 'gemini') {
      const json = (await resp.json()) as { embedding?: { values?: number[] } };
      return json.embedding?.values ?? [];
    }

    const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
    return json.data[0]?.embedding ?? [];
  };
}
