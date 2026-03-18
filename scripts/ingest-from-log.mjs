import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const conversationLogPath = path.resolve(
  process.env.CONVERSATION_LOG_PATH ?? './data/conversation-log.jsonl',
);
const checkpointPath = path.resolve(
  process.env.INGEST_CHECKPOINT_PATH ?? './data/ingest-checkpoint.json',
);
const memoryIngestUrl = new URL(
  '/v1/ingest',
  process.env.MEMORY_INGEST_URL ?? `http://localhost:${process.env.OPENROUTER_PORT || '4010'}`,
).toString();
const rateLimitMs = Number(process.env.INGEST_RATE_LIMIT_MS ?? 1000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readCheckpoint() {
  try {
    const raw = await readFile(checkpointPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastTs: Number(parsed.lastTs) || 0,
      lastId: typeof parsed.lastId === 'string' ? parsed.lastId : '',
    };
  } catch {
    return { lastTs: 0, lastId: '' };
  }
}

async function writeCheckpoint(nextCheckpoint) {
  await mkdir(path.dirname(checkpointPath), { recursive: true });
  const payload = `${JSON.stringify(nextCheckpoint, null, 2)}\n`;
  await writeFile(checkpointPath, payload, 'utf8');
}

function parseLogLines(raw) {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && Array.isArray(entry.messages) && typeof entry.ts === 'number')
    .map((entry) => ({
      id: typeof entry.id === 'string' ? entry.id : '',
      ts: entry.ts,
      agentId: typeof entry.agentId === 'string' && entry.agentId ? entry.agentId : 'default',
      userId: typeof entry.userId === 'string' ? entry.userId : undefined,
      messages: entry.messages
        .map((m) => ({
          role: typeof m?.role === 'string' ? m.role : 'user',
          content: typeof m?.content === 'string' ? m.content.trim() : '',
        }))
        .filter((m) => m.content.length > 0),
    }))
    .filter((entry) => entry.messages.length > 0);
}

function isAfterCheckpoint(entry, checkpoint) {
  if (entry.ts > checkpoint.lastTs) return true;
  if (entry.ts < checkpoint.lastTs) return false;
  return entry.id > checkpoint.lastId;
}

async function ingestOne(entry) {
  const response = await fetch(memoryIngestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent: entry.agentId,
      userId: entry.userId,
      messages: entry.messages,
      deduplicate: true,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ingest failed (${response.status}): ${text}`);
  }
}

async function main() {
  if (!fs.existsSync(conversationLogPath)) {
    console.log(`[ingest-from-log] no log file at ${conversationLogPath}`);
    return;
  }

  const checkpoint = await readCheckpoint();
  const rawLog = await readFile(conversationLogPath, 'utf8');
  const entries = parseLogLines(rawLog)
    .filter((entry) => isAfterCheckpoint(entry, checkpoint))
    .sort((a, b) => (a.ts === b.ts ? a.id.localeCompare(b.id) : a.ts - b.ts));

  if (!entries.length) {
    console.log('[ingest-from-log] no new conversations');
    return;
  }

  let processed = 0;
  let lastCheckpoint = checkpoint;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    await ingestOne(entry);
    lastCheckpoint = { lastTs: entry.ts, lastId: entry.id };
    await writeCheckpoint(lastCheckpoint);
    processed += 1;

    if (index < entries.length - 1) {
      await sleep(rateLimitMs);
    }
  }

  console.log(`[ingest-from-log] processed ${processed} conversations`);
}

main().catch((err) => {
  console.error(`[ingest-from-log] ${err.message}`);
  process.exitCode = 1;
});
