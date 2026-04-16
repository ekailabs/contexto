import {
  createMindmap,
  memoryStorage,
  type Mindmap,
  type MindmapConfig,
  type SearchOptions,
} from '@ekai/mindmap';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// --- Config ---

const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(__dirname, '../configs/default.json');
const config = JSON.parse(readFileSync(configPath, 'utf-8'));

const provider = config.provider ?? 'openrouter';
const embedModel = config.embedModel ?? 'openai/text-embedding-3-small';
const apiKey = process.env.API_KEY ?? '';
const mindmapConfig: Partial<MindmapConfig> = config.mindmap ?? {};
const searchDefaults: SearchOptions = config.search ?? {};

if (!apiKey) {
  console.warn('[bridge] WARNING: API_KEY env var not set. Embedding calls will fail.');
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

  const mindmap = createMindmap({
    provider,
    apiKey,
    embedModel,
    storage: memoryStorage(),
    config: mindmapConfig,
  });

  await mindmap.add(items);
  mindmaps.set(episodeId, mindmap);

  const state = await mindmap.getState();
  return { success: true, totalItems: state.stats.totalItems };
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
