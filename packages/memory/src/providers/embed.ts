import type { EmbedFn, ProviderName, SectorName } from '../types.js';
import { PROVIDERS, buildUrl, getApiKey, getModel, resolveProvider, type ProviderConfig } from './registry.js';

async function callEmbed(cfg: ProviderConfig, model: string, apiKey: string, text: string): Promise<number[]> {
  const { url, headers } = buildUrl(cfg, 'embed', model, apiKey);

  const body =
    cfg.name === 'gemini'
      ? { model, content: { parts: [{ text }] } }
      : { model, input: text };

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const b = await resp.text();
    throw new Error(`${cfg.name} embed failed: ${resp.status} ${b}`);
  }

  if (cfg.name === 'gemini') {
    const json = (await resp.json()) as { embedding?: { values?: number[] } };
    return json.embedding?.values ?? [];
  }

  const json = (await resp.json()) as { data: Array<{ embedding: number[] }> };
  return json.data[0]?.embedding ?? [];
}

/** Env-based embed (legacy). Resolves provider from MEMORY_EMBED_PROVIDER env var. */
export async function embed(text: string, _sector: SectorName): Promise<number[]> {
  const cfg = resolveProvider('embed');
  const apiKey = getApiKey(cfg);
  const model = getModel(cfg, 'embed');
  return callEmbed(cfg, model, apiKey, text);
}

/** Factory: create an EmbedFn from explicit provider config. */
export function createEmbedFn(opts: { provider: ProviderName; apiKey: string; embedModel?: string }): EmbedFn {
  const cfg = PROVIDERS[opts.provider];
  const model = opts.embedModel ?? cfg.defaultEmbedModel;
  const apiKey = opts.apiKey;
  return (text: string, _sector: SectorName) => callEmbed(cfg, model, apiKey, text);
}
