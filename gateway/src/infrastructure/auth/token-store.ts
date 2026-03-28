import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';

export interface OAuthTokens {
  provider: 'openai' | 'anthropic';
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId?: string;
  email?: string;
}

interface TokenStoreData {
  tokens: Record<string, OAuthTokens>;
}

const STORE_DIR = path.join(process.cwd(), '.ekai');
const STORE_PATH = path.join(STORE_DIR, 'oauth-tokens.json');

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function readStore(): TokenStoreData {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    }
  } catch (error) {
    logger.error('Failed to read token store', error, { module: 'token-store' });
  }
  return { tokens: {} };
}

function writeStore(data: TokenStoreData): void {
  ensureStoreDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function saveTokens(provider: 'openai' | 'anthropic', tokens: OAuthTokens): void {
  const store = readStore();
  store.tokens[provider] = tokens;
  writeStore(store);
  logger.info('OAuth tokens saved', { provider, module: 'token-store' });
}

export function getTokens(provider: 'openai' | 'anthropic'): OAuthTokens | undefined {
  const store = readStore();
  return store.tokens[provider];
}

export function removeTokens(provider: 'openai' | 'anthropic'): void {
  const store = readStore();
  delete store.tokens[provider];
  writeStore(store);
  logger.info('OAuth tokens removed', { provider, module: 'token-store' });
}

export function isTokenExpired(tokens: OAuthTokens): boolean {
  return Date.now() >= tokens.expiresAt - 60000;
}

export function listProviders(): string[] {
  const store = readStore();
  return Object.keys(store.tokens);
}
