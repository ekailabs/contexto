import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { logger } from '../utils/logger.js';

export interface StoredKey {
  id: string;
  provider: string;
  label: string;
  key: string;
  priority: number;
  source: 'manual' | 'env';
  addedAt: string;
}

interface KeyStoreData {
  keys: StoredKey[];
}

const STORE_DIR = path.join(process.cwd(), '.ekai');
const STORE_PATH = path.join(STORE_DIR, 'keys.json');

function ensureStoreDir(): void {
  if (!fs.existsSync(STORE_DIR)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  }
}

function readStore(): KeyStoreData {
  try {
    if (fs.existsSync(STORE_PATH)) {
      return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
    }
  } catch (error) {
    logger.error('Failed to read key store', error, { module: 'key-store' });
  }
  return { keys: [] };
}

function writeStore(data: KeyStoreData): void {
  ensureStoreDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function addKey(provider: string, key: string, label?: string, priority?: number): StoredKey {
  const store = readStore();
  const existing = store.keys.find(k => k.provider === provider && k.key === key);
  if (existing) return existing;

  const maxPriority = store.keys
    .filter(k => k.provider === provider)
    .reduce((max, k) => Math.max(max, k.priority), 0);

  const entry: StoredKey = {
    id: crypto.randomUUID(),
    provider,
    label: label || `${provider}-key-${store.keys.filter(k => k.provider === provider).length + 1}`,
    key,
    priority: priority ?? maxPriority + 1,
    source: 'manual',
    addedAt: new Date().toISOString(),
  };

  store.keys.push(entry);
  writeStore(store);
  logger.info('Key added', { provider, label: entry.label, module: 'key-store' });
  return entry;
}

export function removeKey(id: string): boolean {
  const store = readStore();
  const idx = store.keys.findIndex(k => k.id === id);
  if (idx === -1) return false;
  const removed = store.keys.splice(idx, 1)[0];
  writeStore(store);
  logger.info('Key removed', { provider: removed.provider, label: removed.label, module: 'key-store' });
  return true;
}

export function getKeysForProvider(provider: string): StoredKey[] {
  const store = readStore();
  return store.keys
    .filter(k => k.provider === provider)
    .sort((a, b) => a.priority - b.priority);
}

export function getAllKeys(): StoredKey[] {
  return readStore().keys.sort((a, b) => {
    if (a.provider !== b.provider) return a.provider.localeCompare(b.provider);
    return a.priority - b.priority;
  });
}

export function updateKeyPriority(id: string, priority: number): boolean {
  const store = readStore();
  const key = store.keys.find(k => k.id === id);
  if (!key) return false;
  key.priority = priority;
  writeStore(store);
  return true;
}

export function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

export function seedFromEnv(provider: string, envVar: string): void {
  const value = process.env[envVar];
  if (!value) return;
  const store = readStore();
  const exists = store.keys.some(k => k.provider === provider && k.key === value);
  if (exists) return;

  const entry: StoredKey = {
    id: crypto.randomUUID(),
    provider,
    label: `${provider}-env`,
    key: value,
    priority: 999,
    source: 'env',
    addedAt: new Date().toISOString(),
  };
  store.keys.push(entry);
  writeStore(store);
}
