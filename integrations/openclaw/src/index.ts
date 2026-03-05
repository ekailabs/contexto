import { Memory } from '@ekai/memory';
import { readFileSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import os from 'node:os';
import { runBootstrap, type BootstrapProgress } from './bootstrap.js';

// --- Inline helpers ---

export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .filter((c: any) => c?.type === 'text' && c?.text)
      .map((c: any) => c.text)
      .join('\n');
  if (content && typeof content === 'object' && 'text' in content) return String((content as any).text);
  return '';
}

export function normalizeMessages(raw: unknown[]): Array<{ role: string; content: string }> {
  return raw
    .filter((m: any) => m?.role === 'user' || m?.role === 'assistant')
    .map((m: any) => ({ role: m.role, content: extractText(m.content) }))
    .filter((m) => m.content.trim().length > 0);
}

export const REDACT_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+\/=-]+/g,
  /\b(sk|pk|api)[_-][A-Za-z0-9]{20,}\b/g,
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/g,
];

export function redact(text: string): string {
  let out = text;
  for (const p of REDACT_PATTERNS) out = out.replace(p, '[REDACTED]');
  return out;
}

export function lastUserMessage(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?.role === 'user') {
      const t = extractText(m.content);
      if (t.trim()) return t;
    }
  }
}

export function loadProgress(path: string): BootstrapProgress {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return {};
  }
}

// --- Plugin definition ---

export default {
  id: 'claw-contexto',
  name: 'Ekai Contexto',
  description: 'Local-first memory for OpenClaw',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dbPath: { type: 'string' },
      provider: { type: 'string' },
      apiKey: { type: 'string' },
    },
  },

  register(api: any) {
    const dbPath = api.resolvePath(api.pluginConfig?.dbPath ?? '~/.openclaw/ekai/memory.db');
    mkdirSync(dirname(dbPath), { recursive: true });
    const mem = new Memory({
      provider: api.pluginConfig?.provider,
      apiKey: api.pluginConfig?.apiKey,
      dbPath,
    });

    // --- Agent management ---
    const knownAgents = new Set<string>();
    function ensureAgent(agentId: string) {
      if (knownAgents.has(agentId)) return;
      const exists = mem.getAgents().some((a) => a.id === agentId);
      if (!exists) mem.addAgent(agentId, { name: agentId });
      knownAgents.add(agentId);
    }
    // Seed from existing agents in DB (survives restarts)
    for (const a of mem.getAgents()) knownAgents.add(a.id);
    ensureAgent('main');

    // --- Delta tracking (persisted) ---
    const progressPath = dbPath.replace(/\.db$/, '') + '.progress.json';
    const progress: BootstrapProgress = loadProgress(progressPath);

    async function saveProgress() {
      const tmp = progressPath + '.tmp';
      await writeFile(tmp, JSON.stringify(progress), 'utf-8');
      await rename(tmp, progressPath);
    }

    const MAX_PREPEND_CHARS = 2000;

    // --- agent_end: ingest delta ---
    api.on('agent_end', async (event: any, ctx: any) => {
      const sessionId = ctx?.sessionId ?? ctx?.sessionKey;
      if (!sessionId || !event?.messages?.length) return;

      const agentId = ctx?.agentId ?? 'main';
      const progressKey = `${agentId}:${sessionId}`;
      const lastCount = (progress[progressKey] as number) ?? 0;
      // Handle count shrink (e.g. compaction) — re-ingest from start
      const startIdx = event.messages.length < lastCount ? 0 : lastCount;
      if (startIdx >= event.messages.length) return;

      try {
        ensureAgent(agentId);

        const delta = event.messages.slice(startIdx);
        const turns = normalizeMessages(delta);
        if (turns.length === 0) {
          progress[progressKey] = event.messages.length;
          await saveProgress();
          return;
        }

        const redacted = turns.map((t) => ({ role: t.role, content: redact(t.content) }));
        await mem.agent(agentId).add(redacted, { userId: ctx?.userId });
        progress[progressKey] = event.messages.length;
        await saveProgress();

        api.logger.info(`claw-contexto: ingested ${redacted.length} turns`);
      } catch (err) {
        api.logger.warn(`claw-contexto: ingest failed: ${String(err)}`);
      }
    });

    // --- before_prompt_build: recall ---
    api.on('before_prompt_build', async (event: any, ctx: any) => {
      try {
        const agentId = ctx?.agentId ?? 'main';
        if (!knownAgents.has(agentId)) return;

        const query = lastUserMessage(event?.messages ?? []);
        if (!query) return;

        const results = await mem.agent(agentId).search(query, { userId: ctx?.userId });
        if (results.length === 0) return;

        let block = results
          .slice(0, 5)
          .map((r: any) => `- ${r.content}`)
          .join('\n');

        if (block.length > MAX_PREPEND_CHARS) block = block.slice(0, MAX_PREPEND_CHARS) + '…';

        return { prependContext: `## Relevant memories\n${block}` };
      } catch (err) {
        api.logger.warn(`claw-contexto: recall failed: ${String(err)}`);
      }
    });

    // --- /memory-bootstrap command ---
    api.registerCommand({
      name: 'memory-bootstrap',
      description: 'Backfill existing session history into memory',
      acceptsArgs: false,
      requireAuth: true,
      handler: async () => {
        if (progress.__bootstrap?.status === 'done') {
          return { text: 'Bootstrap already completed.' };
        }
        if (progress.__bootstrap?.status === 'running') {
          return { text: 'Bootstrap already in progress.' };
        }

        const stateDir = api.runtime?.state?.resolveStateDir?.(process.env, os.homedir());
        if (!stateDir) {
          return { text: 'Could not resolve state directory.' };
        }

        progress.__bootstrap = { status: 'running', startedAt: Date.now() };
        await saveProgress();

        runBootstrap({
          stateDir,
          mem,
          progress,
          saveProgress,
          logger: api.logger,
          ensureAgent,
          delayMs: Math.max(0, Number(api.pluginConfig?.bootstrapDelayMs) || 1000),
        })
          .then((r) => api.logger.info(`claw-contexto: bootstrap done — ${r.sessionsProcessed} sessions`))
          .catch((err) => {
            api.logger.warn(`claw-contexto: bootstrap failed: ${err}`);
            progress.__bootstrap = undefined;
            saveProgress();
          });

        return { text: 'Memory bootstrap started. Check logs for progress.' };
      },
    });

    api.logger.info(`claw-contexto: memory at ${dbPath}`);
  },
};
