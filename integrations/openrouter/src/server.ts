import express from 'express';
import { PORT } from './config.js';
import { fetchMemoryContext, formatMemoryBlock, ingestMessages, injectMemory } from './memory.js';
import { proxyToOpenRouter } from './proxy.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const body = req.body;
    const profile = (req.headers['x-memory-profile'] as string) || 'default';

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
        injectMemory(body.messages, block);
      }
    }

    // Fire-and-forget: ingest original messages for future recall
    ingestMessages(originalMessages, profile);

    await proxyToOpenRouter(body, res);
  } catch (err: any) {
    console.error(`[server] unhandled error: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

app.listen(PORT, () => {
  console.log(`@ekai/openrouter listening on port ${PORT}`);
});
