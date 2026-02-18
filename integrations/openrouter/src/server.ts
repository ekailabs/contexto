import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { SqliteMemoryStore, embed, createMemoryRouter } from '@ekai/memory';
import { PORT, MEMORY_DB_PATH } from './config.js';
import { initMemoryStore, fetchMemoryContext, ingestMessages } from './memory-client.js';
import { formatMemoryBlock, injectMemory } from './memory.js';
import { proxyToOpenRouter } from './proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

const corsOrigins =
  process.env.MEMORY_CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean) ?? '*';
app.use(cors({ origin: corsOrigins }));
app.options('*', cors({ origin: corsOrigins }));
app.use(express.json({ limit: '10mb' }));

// Initialize embedded memory store
const store = new SqliteMemoryStore({
  dbPath: MEMORY_DB_PATH,
  embed,
});
initMemoryStore(store);

// Mount memory admin routes (dashboard, graph, etc.)
app.use(createMemoryRouter(store));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const body = req.body;
    // Profile from body.user (PydanticAI openai_user), header, or default
    const profile = body.user || (req.headers['x-memory-profile'] as string) || 'default';
    // Pass through client's API key if provided, otherwise proxy.ts falls back to env
    const authHeader = req.headers['authorization'] as string | undefined;
    const clientKey = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;

    // Extract last user message for memory query
    const lastUserMsg = [...(body.messages || [])]
      .reverse()
      .find((m: any) => m.role === 'user');
    const query =
      typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content
        : Array.isArray(lastUserMsg?.content)
          ? lastUserMsg.content
              .filter((p: any) => p.type === 'text')
              .map((p: any) => p.text)
              .join(' ')
          : null;

    // Save original messages before memory injection mutates them
    const originalMessages = body.messages.map((m: any) => ({ ...m }));

    // Fetch memory context (non-blocking on failure)
    if (query) {
      const results = await fetchMemoryContext(query, profile);
      if (results) {
        const block = formatMemoryBlock(results);
        body.messages = injectMemory(body.messages, block);
      }
    }

    // Fire-and-forget: ingest original messages for future recall
    ingestMessages(originalMessages, profile);

    await proxyToOpenRouter(body, res, clientKey);
  } catch (err: any) {
    console.error(`[server] unhandled error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// ---------- Embedded dashboard (static export) ----------
const DASHBOARD_DIR = process.env.DASHBOARD_STATIC_DIR
  ? path.resolve(process.env.DASHBOARD_STATIC_DIR)
  : path.resolve(__dirname, '../../dashboard-static');

if (fs.existsSync(DASHBOARD_DIR)) {
  // Serve static assets (JS, CSS, images, etc.)
  app.use(express.static(DASHBOARD_DIR));

  // SPA catch-all: serve pre-rendered .html for page routes, fallback to index.html
  app.get('*', (req, res) => {
    // Try <route>.html first (e.g. /memory → /memory.html)
    const htmlFile = path.join(DASHBOARD_DIR, `${req.path}.html`);
    if (fs.existsSync(htmlFile)) {
      return res.sendFile(htmlFile);
    }
    // Try <route>/index.html (e.g. /memory/ → /memory/index.html)
    const indexFile = path.join(DASHBOARD_DIR, req.path, 'index.html');
    if (fs.existsSync(indexFile)) {
      return res.sendFile(indexFile);
    }
    // Fallback to root index.html
    res.sendFile(path.join(DASHBOARD_DIR, 'index.html'));
  });

  console.log(`[dashboard] serving static files from ${DASHBOARD_DIR}`);
}

app.listen(PORT, () => {
  console.log(`@ekai/openrouter listening on port ${PORT} (memory embedded, db at ${MEMORY_DB_PATH})`);
});
