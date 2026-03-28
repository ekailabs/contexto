import { logger } from '../utils/logger.js';
import { getConfig } from '../config/app-config.js';
import { FileMemoryService } from './file-memory.js';

export interface MemoryItem {
  id?: string;
  userId: string;
  agentId?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt?: string;
}

export interface MemoryService {
  add(item: MemoryItem): void;
  retrieve(params: { userId: string; agentId?: string | null; limit?: number }): MemoryItem[];
  update(params: { id: string; content?: string; metadata?: Record<string, unknown> | null }): void;
  delete(params: { id?: string; userId?: string; before?: Date }): void;
}

class NoopMemoryService implements MemoryService {
  add(): void {
    logger.debug('Memory disabled: add noop', { module: 'memory-service' });
  }

  retrieve(): MemoryItem[] {
    return [];
  }

  update(): void {
    logger.debug('Memory disabled: update noop', { module: 'memory-service' });
  }

  delete(): void {
    logger.debug('Memory disabled: delete noop', { module: 'memory-service' });
  }
}

export function createMemoryService(): MemoryService {
  const config = getConfig();

  if (config.memory.backend === 'none') {
    return new NoopMemoryService();
  }

  switch (config.memory.backend) {
    case 'file':
      return new FileMemoryService(config.memory.maxItems);
    default:
      logger.warn('Unknown memory backend, falling back to noop', {
        backend: config.memory.backend,
        module: 'memory-service',
      });
      return new NoopMemoryService();
  }
}

export const memoryService = createMemoryService();
