import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load env from memory/.env (dist is under memory/dist) then repo root .env
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import type { ProviderName } from './types.js';
import { Memory } from './memory.js';
import { createMemoryRouter } from './router.js';

const PORT = Number(process.env.MEMORY_PORT ?? 4005);
const DB_PATH = process.env.MEMORY_DB_PATH ?? './memory.db';

// Resolve provider config from env
const provider = (process.env.MEMORY_EMBED_PROVIDER ?? process.env.MEMORY_EXTRACT_PROVIDER ?? 'gemini') as ProviderName;
const apiKeyEnvMap: Record<ProviderName, string> = {
  gemini: 'GOOGLE_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const apiKey = process.env[apiKeyEnvMap[provider]] ?? '';

async function main() {
  const app = express();
  const corsOrigins =
    process.env.MEMORY_CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean) ?? '*';
  app.use(
    cors({
      origin: corsOrigins,
    }),
  );
  app.options('*', cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '2mb' }));

  const memory = new Memory({
    provider,
    apiKey,
    dbPath: DB_PATH,
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use(createMemoryRouter(memory._store, memory._extractFn));

  // Fallback 404 with CORS headers
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Memory service listening on :${PORT}, db at ${DB_PATH}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
