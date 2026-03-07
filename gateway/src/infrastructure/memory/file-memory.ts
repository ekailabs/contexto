import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';
import type { MemoryItem, MemoryService } from './memory-service.js';

const DEFAULT_MEMORY_FILE = 'memory/MEMORY.md';

interface FileMemoryRecord {
  id: string;
  userId: string;
  agentId?: string | null;
  content: string;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

export class FileMemoryService implements MemoryService {
  private readonly absolutePath: string;

  constructor(private readonly maxItems: number) {
    // Store memory file relative to process.cwd() (project root)
    this.absolutePath = resolve(process.cwd(), DEFAULT_MEMORY_FILE);
  }

  add(item: MemoryItem): void {
    if (!item.userId?.trim() || !item.content?.trim()) {
      logger.warn('Skipping memory write due to missing userId/content', { module: 'file-memory-service' });
      return;
    }

    const records = this.readRecords();
    const record: FileMemoryRecord = {
      id: item.id ?? randomUUID(),
      userId: item.userId,
      agentId: item.agentId ?? null,
      content: item.content,
      metadata: item.metadata ?? null,
      createdAt: item.createdAt ?? new Date().toISOString(),
    };

    records.push(record);

    if (this.maxItems > 0) {
      while (records.length > this.maxItems) {
        records.shift();
      }
    }

    this.writeRecords(records);
  }

  retrieve(params: { userId: string; agentId?: string | null; limit?: number }): MemoryItem[] {
    if (!params.userId?.trim()) {
      return [];
    }

    const limit = params.limit ?? (this.maxItems > 0 ? this.maxItems : Number.POSITIVE_INFINITY);
    const records = this.readRecords()
      .filter((record) => record.userId === params.userId)
      .filter((record) => (params.agentId ? record.agentId === params.agentId : true))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    return records.map((record) => ({
      id: record.id,
      userId: record.userId,
      agentId: record.agentId,
      content: record.content,
      metadata: record.metadata ?? null,
      createdAt: record.createdAt,
    }));
  }

  update(params: { id: string; content?: string; metadata?: Record<string, unknown> | null }): void {
    if (!params.id) return;
    const records = this.readRecords();
    const updated = records.map((record) => {
      if (record.id !== params.id) return record;
      return {
        ...record,
        content: params.content ?? record.content,
        metadata: params.metadata === undefined ? record.metadata : params.metadata,
      };
    });
    this.writeRecords(updated);
  }

  delete(params: { id?: string; userId?: string; before?: Date }): void {
    if (!params.id && !params.userId && !params.before) {
      return;
    }

    const records = this.readRecords();
    const filtered = records.filter((record) => {
      if (params.id && record.id === params.id) return false;
      if (params.userId && record.userId === params.userId && !params.id && !params.before) {
        return false;
      }
      if (params.before && new Date(record.createdAt) < params.before) {
        return false;
      }
      return true;
    });

    this.writeRecords(filtered);
  }

  private readRecords(): FileMemoryRecord[] {
    try {
      if (!existsSync(this.absolutePath)) {
        return [];
      }
      const raw = readFileSync(this.absolutePath, 'utf8').trim();
      if (!raw) return [];
      return JSON.parse(raw) as FileMemoryRecord[];
    } catch (error) {
      logger.warn('Failed to read memory file, returning empty records', { error, module: 'file-memory-service' });
      return [];
    }
  }

  private writeRecords(records: FileMemoryRecord[]): void {
    const directory = dirname(this.absolutePath);
    mkdirSync(directory, { recursive: true });
    const payload = JSON.stringify(records, null, 2);
    writeFileSync(this.absolutePath, payload + '\n');
  }
}
