import type { SqliteMemoryStore } from '@ekai/memory';
import { extract } from '@ekai/memory';

interface QueryResult {
  sector: 'episodic' | 'semantic' | 'procedural' | 'reflective';
  content: string;
  score: number;
  details?: {
    subject?: string;
    predicate?: string;
    object?: string;
    domain?: string;
    trigger?: string;
    steps?: string[];
    goal?: string;
  };
}

let store: SqliteMemoryStore | null = null;

/**
 * Initialize the memory store reference. Called once at startup.
 */
export function initMemoryStore(s: SqliteMemoryStore): void {
  store = s;
}

/**
 * Fetch memory context by querying the store directly.
 * Returns null on any failure — memory is additive, never blocking.
 */
export async function fetchMemoryContext(
  query: string,
  profile: string,
  userId?: string,
): Promise<QueryResult[] | null> {
  if (!store) {
    console.warn('[memory] store not initialized');
    return null;
  }
  try {
    const data = await store.query(query, profile, userId);
    return data.workingMemory?.length ? data.workingMemory : null;
  } catch (err: any) {
    console.warn(`[memory] search failed: ${err.message}`);
    return null;
  }
}

/**
 * Fire-and-forget: extract and ingest messages into the memory store.
 * Never awaited — failures are logged and swallowed.
 */
export function ingestMessages(
  messages: Array<{ role: string; content: string }>,
  profile: string,
): void {
  if (!store) {
    console.warn('[memory] store not initialized, skipping ingest');
    return;
  }

  const allMessages = messages.filter((m) => m.content?.trim());
  const sourceText = allMessages
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.trim()}`)
    .join('\n\n');

  if (!sourceText) return;

  // Fire-and-forget: extract then ingest
  extract(sourceText)
    .then((components) => {
      if (!components || !store) return;
      return store.ingest(components, profile, {
        origin: { originType: 'conversation' },
      });
    })
    .catch((err) => {
      console.warn(`[memory] ingest failed: ${err.message}`);
    });
}
