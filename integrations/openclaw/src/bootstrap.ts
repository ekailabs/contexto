import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { Memory } from '@ekai/memory';
import { normalizeMessages, redact } from './index.js';

export type BootstrapStatus = {
  status: 'running' | 'done';
  startedAt?: number;
  completedAt?: number;
  sessionsProcessed?: number;
};

export type BootstrapProgress = {
  __bootstrap?: BootstrapStatus;
  [key: string]: number | BootstrapStatus | undefined;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function listJsonl(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && !f.includes('.reset.'));
  } catch {
    return [];
  }
}

export async function runBootstrap(opts: {
  stateDir: string;
  mem: Memory;
  progress: BootstrapProgress;
  saveProgress: () => Promise<void>;
  logger: { info(m: string): void; warn(m: string): void };
  delayMs?: number;
  ensureAgent: (id: string) => void;
}): Promise<{ sessionsProcessed: number }> {
  const { stateDir, mem, progress, saveProgress, logger, ensureAgent } = opts;
  const delayMs = Math.max(0, opts.delayMs ?? 1000);

  if (progress.__bootstrap?.status === 'done') {
    return { sessionsProcessed: 0 };
  }

  progress.__bootstrap = { status: 'running', startedAt: Date.now() };
  await saveProgress();

  const agentsDir = join(stateDir, 'agents');
  const agentDirs = listDirs(agentsDir);

  if (agentDirs.length === 0) {
    progress.__bootstrap = { status: 'done', completedAt: Date.now(), sessionsProcessed: 0 };
    await saveProgress();
    return { sessionsProcessed: 0 };
  }

  let count = 0;

  for (const agentId of agentDirs) {
    const sessionsDir = join(agentsDir, agentId, 'sessions');
    const files = listJsonl(sessionsDir);

    for (const file of files) {
      const sessionId = basename(file, '.jsonl');
      const compositeKey = `${agentId}:${sessionId}`;
      if (compositeKey in progress) continue;

      const filePath = join(sessionsDir, file);
      const raw = readFileSync(filePath, 'utf-8');
      const lines = raw.split('\n');
      const messages: unknown[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.trim()) continue;

        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          logger.warn(`@ekai/contexto: malformed JSON in ${file} line ${i + 1}`);
          continue;
        }

        if (entry.type === 'message' && entry.message) {
          messages.push(entry.message);
        }
      }

      const turns = normalizeMessages(messages);
      if (turns.length > 0) {
        const redacted = turns.map((t) => ({ role: t.role, content: redact(t.content) }));
        ensureAgent(agentId);
        await mem.agent(agentId).add(redacted);
      }

      progress[compositeKey] = messages.length;
      await saveProgress();
      count++;

      if (delayMs > 0) await delay(delayMs);
    }
  }

  progress.__bootstrap = { status: 'done', completedAt: Date.now(), sessionsProcessed: count };
  await saveProgress();
  return { sessionsProcessed: count };
}
