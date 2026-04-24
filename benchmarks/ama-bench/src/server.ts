import {
  createEmbedFn,
  createMindmap,
  memoryStorage,
  type EmbedFn,
  type EmbedProvider,
  type Mindmap,
  type MindmapConfig,
  type SearchOptions,
} from '@ekai/mindmap';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createSummarizer, type Summarizer } from './episodic/summary.js';

// --- Config ---

const __dirname = dirname(fileURLToPath(import.meta.url));
// BENCH_CONFIG env var lets run.sh point us at a preset (local.json / openai.json / hybrid.json)
// without mutating default.json.
const configPath = process.env.BENCH_CONFIG
  ? resolve(process.env.BENCH_CONFIG)
  : resolve(__dirname, '../configs/default.json');
console.log(`[bridge] Loading config from ${configPath}`);
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

interface EmbedConfig {
  type?: string;          // 'ollama' | 'openai' | 'openrouter' | 'gemini'
  baseUrl?: string;       // ollama only
  model?: string;         // model name (provider-specific)
  apiKey?: string;        // cloud providers (falls back to API_KEY env var)
}

const embedCfg: EmbedConfig = config.embed ?? {};
const embedType = embedCfg.type ?? 'ollama';
const mindmapConfig: Partial<MindmapConfig> = config.mindmap ?? {};
const searchDefaults: SearchOptions = config.search ?? {};

// --- Embed functions ---

function makeOllamaEmbedFn({ baseUrl, model }: { baseUrl: string; model: string }): EmbedFn {
  return async (text: string): Promise<number[]> => {
    const resp = await fetch(`${baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '(no body)');
      throw new Error(`ollama embed failed: ${resp.status} ${body}`);
    }
    const json = (await resp.json()) as { embedding: number[] };
    return json.embedding;
  };
}

function buildEmbedFn(): EmbedFn {
  if (embedType === 'ollama') {
    const baseUrl = embedCfg.baseUrl ?? 'http://localhost:11434';
    const model = embedCfg.model ?? 'qwen3-embedding:0.6b';
    console.log(`[bridge] Embed: ollama ${baseUrl} model=${model}`);
    return makeOllamaEmbedFn({ baseUrl, model });
  }

  // Cloud providers — delegate to @ekai/mindmap's built-in embed client
  if (embedType === 'openai' || embedType === 'openrouter' || embedType === 'gemini') {
    const apiKey = embedCfg.apiKey ?? process.env.API_KEY ?? '';
    if (!apiKey) {
      throw new Error(
        `embed.type='${embedType}' requires an apiKey (set embed.apiKey in configs/default.json or API_KEY env var).`,
      );
    }
    console.log(`[bridge] Embed: ${embedType} model=${embedCfg.model ?? '(provider default)'}`);
    return createEmbedFn({
      provider: embedType as EmbedProvider,
      apiKey,
      model: embedCfg.model,
    });
  }

  throw new Error(
    `Unsupported embed.type '${embedType}'. Supported: 'ollama' | 'openai' | 'openrouter' | 'gemini'.`,
  );
}

const embedFn = buildEmbedFn();

// --- Episodic summary layer ---

interface EpisodicConfig {
  enabled?: boolean;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  temperature?: number;
  jsonMode?: boolean;
  noThink?: boolean;
}

const episodicCfg: EpisodicConfig = config.episodic ?? {};
const episodicEnabled = episodicCfg.enabled !== false; // default on

let summarizer: Summarizer | null = null;
if (episodicEnabled) {
  const baseUrl = episodicCfg.baseUrl ?? 'https://api.openai.com/v1/chat/completions';
  // Local endpoints (VLLM/Ollama/etc.) don't need a real API key
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])/i.test(baseUrl);
  const apiKey =
    episodicCfg.apiKey ?? process.env.API_KEY ?? process.env.OPENAI_API_KEY ?? '';
  if (!apiKey && !isLocal) {
    throw new Error(
      'episodic.enabled=true but no API key found (set episodic.apiKey in configs/default.json, or API_KEY / OPENAI_API_KEY env var).',
    );
  }
  summarizer = createSummarizer({
    baseUrl,
    model: episodicCfg.model ?? 'gpt-4o-mini',
    apiKey: apiKey || undefined,
    temperature: episodicCfg.temperature ?? 0.2,
    jsonMode: episodicCfg.jsonMode,
    noThink: episodicCfg.noThink,
  });
} else {
  console.log('[episodic] disabled — raw turn content will be embedded directly');
}

// --- Types ---

interface ConstructRequest {
  episodeId: string;
  items: Array<{ id: string; role: string; content: string; metadata?: Record<string, unknown> }>;
}

interface RetrieveRequest {
  episodeId: string;
  question: string;
  searchOptions?: SearchOptions;
}

interface ResetRequest {
  episodeId: string;
}

// --- State ---

const mindmaps = new Map<string, Mindmap>();

// --- Handlers ---

async function handleConstruct(body: ConstructRequest) {
  const { episodeId, items } = body;

  mindmaps.delete(episodeId);

  // When the episodic layer is enabled, each raw turn is sent to an LLM that
  // produces a structured summary (production's SummaryService behavior).
  // Only the summary content is embedded/stored; raw turn text is preserved
  // in metadata.turn.rawContent for debugging and ablation.
  const toStore = summarizer
    ? await Promise.all(
        items.map((item, idx) => summarizer!.summarizeTurn(item, episodeId, idx)),
      )
    : items.map((item) => ({
        id: item.id,
        role: item.role,
        content: item.content,
        metadata: item.metadata,
      }));

  const mindmap = createMindmap({
    embedFn,
    storage: memoryStorage(),
    config: mindmapConfig,
  });

  await mindmap.add(toStore);
  mindmaps.set(episodeId, mindmap);

  const state = await mindmap.getState();
  return {
    success: true,
    totalItems: state.stats.totalItems,
    summarized: summarizer !== null,
  };
}

async function handleRetrieve(body: RetrieveRequest) {
  const { episodeId, question, searchOptions } = body;

  const mindmap = mindmaps.get(episodeId);
  if (!mindmap) {
    throw new Error(`No mindmap found for episode ${episodeId}. Call /construct first.`);
  }

  const opts = { ...searchDefaults, ...searchOptions };
  const result = await mindmap.search(question, opts);
  const context = result.items.map((si) => si.item.content).join('\n\n');

  return { context, totalCandidates: result.totalCandidates };
}

function handleReset(body: ResetRequest) {
  mindmaps.delete(body.episodeId);
  return { success: true };
}

// --- Server ---

const PORT = parseInt(process.env.BRIDGE_PORT ?? '3456', 10);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/health') {
      return Response.json({ status: 'ok', activeEpisodes: mindmaps.size });
    }

    if (req.method !== 'POST') {
      return Response.json({ error: 'Method not allowed' }, { status: 405 });
    }

    try {
      const body = await req.json();

      if (path === '/construct') {
        return Response.json(await handleConstruct(body as ConstructRequest));
      } else if (path === '/retrieve') {
        return Response.json(await handleRetrieve(body as RetrieveRequest));
      } else if (path === '/reset') {
        return Response.json(handleReset(body as ResetRequest));
      }

      return Response.json({ error: 'Not found' }, { status: 404 });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[bridge] Error on ${path}:`, message);
      return Response.json({ error: message }, { status: 500 });
    }
  },
});

console.log(`[bridge] Mindmap bridge server listening on http://localhost:${server.port}`);
