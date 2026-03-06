import { Memory, type ProviderName } from '@ekai/memory';
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

// --- Provider auto-detection ---

const PROVIDER_ENV_KEYS: Record<ProviderName, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const AUTO_DETECT_ORDER: Array<{ env: string; provider: ProviderName }> = [
  { env: 'OPENAI_API_KEY', provider: 'openai' },
  { env: 'GOOGLE_API_KEY', provider: 'gemini' },
  { env: 'OPENROUTER_API_KEY', provider: 'openrouter' },
];

export function resolveMemoryProvider(
  pluginConfig: any,
  logger: { info(m: string): void; warn(m: string): void },
): { provider: ProviderName; apiKey: string; source: string } | undefined {
  const cfgProvider = pluginConfig?.provider;
  const cfgApiKey = pluginConfig?.apiKey;

  // Case 1: both explicit
  if (cfgProvider && cfgApiKey) {
    return { provider: cfgProvider as ProviderName, apiKey: cfgApiKey, source: 'config' };
  }

  // Case 2: provider only → resolve key from env
  if (cfgProvider && !cfgApiKey) {
    const envVar = PROVIDER_ENV_KEYS[cfgProvider];
    const key = envVar && process.env[envVar];
    if (key) {
      return { provider: cfgProvider as ProviderName, apiKey: key, source: 'config+env' };
    }
    logger.warn(`@ekai/contexto: provider '${cfgProvider}' configured but ${envVar ?? 'API key env var'} not set`);
    return undefined;
  }

  // Case 3: apiKey only → ambiguous, warn and ignore
  if (!cfgProvider && cfgApiKey) {
    logger.warn('@ekai/contexto: apiKey configured without provider — ignoring (set provider to use it)');
  }

  // Case 4: defer to core if MEMORY_*_PROVIDER is set
  if (process.env.MEMORY_EMBED_PROVIDER || process.env.MEMORY_EXTRACT_PROVIDER) {
    return undefined;
  }

  // Case 5: auto-detect from env keys
  for (const { env, provider } of AUTO_DETECT_ORDER) {
    const key = process.env[env];
    if (key) {
      return { provider, apiKey: key, source: 'env' };
    }
  }

  // Case 6: nothing found, let core handle
  return undefined;
}

// --- Plugin definition ---

export default {
  id: '@ekai/contexto',
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
    const resolved = resolveMemoryProvider(api.pluginConfig, api.logger);
    const mem = new Memory({
      ...(resolved ? { provider: resolved.provider, apiKey: resolved.apiKey } : {}),
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

        api.logger.info(`@ekai/contexto: ingested ${redacted.length} turns`);
      } catch (err) {
        api.logger.warn(`@ekai/contexto: ingest failed: ${String(err)}`);
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
        api.logger.warn(`@ekai/contexto: recall failed: ${String(err)}`);
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
          .then((r) => api.logger.info(`@ekai/contexto: bootstrap done — ${r.sessionsProcessed} sessions`))
          .catch((err) => {
            api.logger.warn(`@ekai/contexto: bootstrap failed: ${err}`);
            progress.__bootstrap = undefined;
            saveProgress();
          });

        return { text: 'Memory bootstrap started. Check logs for progress.' };
      },
    });

    const providerInfo = resolved ? ` (${resolved.provider} via ${resolved.source})` : '';
    api.logger.info(`@ekai/contexto: memory at ${dbPath}${providerInfo}`);
  },
};
