import { Request, Response } from 'express';
import { addKey, removeKey, getAllKeys, updateKeyPriority, maskKey } from '../../infrastructure/auth/key-store.js';
import { logger } from '../../infrastructure/utils/logger.js';

const VALID_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'xai', 'zai', 'google', 'ollama'];

export async function handleListKeys(req: Request, res: Response): Promise<void> {
  try {
    const keys = getAllKeys().map(k => ({
      id: k.id,
      provider: k.provider,
      label: k.label,
      maskedKey: maskKey(k.key),
      priority: k.priority,
      source: k.source,
      addedAt: k.addedAt,
    }));
    res.json({ keys });
  } catch (error) {
    logger.error('Failed to list keys', error, { module: 'key-handler' });
    res.status(500).json({ error: 'Failed to list keys' });
  }
}

export async function handleAddKey(req: Request, res: Response): Promise<void> {
  try {
    const { provider, key, label, priority } = req.body;

    if (!provider || !key) {
      res.status(400).json({ error: 'provider and key are required' });
      return;
    }

    if (!VALID_PROVIDERS.includes(provider)) {
      res.status(400).json({ error: `Invalid provider. Use one of: ${VALID_PROVIDERS.join(', ')}` });
      return;
    }

    if (typeof key !== 'string' || key.trim().length === 0) {
      res.status(400).json({ error: 'key must be a non-empty string' });
      return;
    }

    const stored = addKey(provider, key.trim(), label, priority);
    res.status(201).json({
      id: stored.id,
      provider: stored.provider,
      label: stored.label,
      maskedKey: maskKey(stored.key),
      priority: stored.priority,
      source: stored.source,
      addedAt: stored.addedAt,
    });
  } catch (error) {
    logger.error('Failed to add key', error, { module: 'key-handler' });
    res.status(500).json({ error: 'Failed to add key' });
  }
}

export async function handleRemoveKey(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const removed = removeKey(id);
    if (!removed) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ status: 'removed', id });
  } catch (error) {
    logger.error('Failed to remove key', error, { module: 'key-handler' });
    res.status(500).json({ error: 'Failed to remove key' });
  }
}

export async function handleUpdateKeyPriority(req: Request, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { priority } = req.body;

    if (typeof priority !== 'number' || priority < 0) {
      res.status(400).json({ error: 'priority must be a non-negative number' });
      return;
    }

    const updated = updateKeyPriority(id, priority);
    if (!updated) {
      res.status(404).json({ error: 'Key not found' });
      return;
    }
    res.json({ status: 'updated', id, priority });
  } catch (error) {
    logger.error('Failed to update key priority', error, { module: 'key-handler' });
    res.status(500).json({ error: 'Failed to update key priority' });
  }
}
