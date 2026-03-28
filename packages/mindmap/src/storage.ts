import type { MindmapState } from './types.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface MindmapStorage {
  load(): Promise<MindmapState | null>;
  save(state: MindmapState): Promise<void>;
}

export function jsonFileStorage(filePath: string): MindmapStorage {
  return {
    async load(): Promise<MindmapState | null> {
      try {
        const data = await readFile(filePath, 'utf-8');
        return JSON.parse(data) as MindmapState;
      } catch (err: any) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },

    async save(state: MindmapState): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(state), 'utf-8');
    },
  };
}

export function memoryStorage(): MindmapStorage {
  let state: MindmapState | null = null;
  return {
    async load() { return state; },
    async save(s) { state = s; },
  };
}
