import { getKeysForProvider, seedFromEnv, StoredKey } from './key-store.js';
import { logger } from '../utils/logger.js';

const ENV_MAP: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  xai: 'XAI_API_KEY',
  zai: 'ZAI_API_KEY',
  google: 'GOOGLE_API_KEY',
  ollama: 'OLLAMA_API_KEY',
};

const exhaustedKeys = new Map<string, number>();
const EXHAUSTED_COOLDOWN_MS = 300000;

let seeded = false;

function seedAllFromEnv(): void {
  if (seeded) return;
  seeded = true;
  for (const [provider, envVar] of Object.entries(ENV_MAP)) {
    seedFromEnv(provider, envVar);
  }
}

export function markKeyExhausted(provider: string, keyId: string): void {
  exhaustedKeys.set(`${provider}:${keyId}`, Date.now());
  logger.info('Key marked exhausted', { provider, keyId, cooldownMs: EXHAUSTED_COOLDOWN_MS, module: 'key-manager' });
}

function isKeyExhausted(provider: string, keyId: string): boolean {
  const ts = exhaustedKeys.get(`${provider}:${keyId}`);
  if (!ts) return false;
  if (Date.now() - ts > EXHAUSTED_COOLDOWN_MS) {
    exhaustedKeys.delete(`${provider}:${keyId}`);
    return false;
  }
  return true;
}

export async function resolveKeyForProvider(provider: string): Promise<string | undefined> {
  seedAllFromEnv();

  if (provider === 'openai' || provider === 'anthropic') {
    try {
      const oauthPath = new URL('./oauth-service.js', import.meta.url).href;
      const mod: any = await import(/* @vite-ignore */ oauthPath).catch(() => null);
      if (mod?.getValidAccessToken) {
        const oauthToken = await mod.getValidAccessToken(provider);
        if (oauthToken) {
          logger.debug('Using OAuth token', { provider, module: 'key-manager' });
          return oauthToken;
        }
      }
    } catch {}
  }

  const keys = getKeysForProvider(provider);
  for (const key of keys) {
    if (!isKeyExhausted(provider, key.id)) {
      logger.debug('Using key', { provider, label: key.label, priority: key.priority, module: 'key-manager' });
      return key.key;
    }
  }

  if (keys.length > 0) {
    logger.warn('All keys exhausted, using first key as fallback', { provider, module: 'key-manager' });
    return keys[0].key;
  }

  return undefined;
}

export function getKeyCountForProvider(provider: string): number {
  seedAllFromEnv();
  return getKeysForProvider(provider).length;
}

export function hasAnyKeyForProvider(provider: string): boolean {
  seedAllFromEnv();
  return getKeysForProvider(provider).length > 0;
}
