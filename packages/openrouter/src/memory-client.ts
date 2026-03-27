import type { Memory } from '@ekai/memory';

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

let memory: Memory | null = null;

/**
 * Initialize the Memory instance. Called once at startup.
 */
export function initMemory(m: Memory): void {
  memory = m;
}

/**
 * Fetch memory context by querying the store directly.
 * Returns null on any failure — memory is additive, never blocking.
 */
export async function fetchMemoryContext(
  query: string,
  userId?: string,
): Promise<QueryResult[] | null> {
  if (!memory) {
    console.warn('[memory] not initialized');
    return null;
  }
  try {
    const results = await memory.search(query, { userId });
    return results.length ? results : null;
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
  userId?: string,
): void {
  if (!memory) {
    console.warn('[memory] not initialized, skipping ingest');
    return;
  }

  memory.add(messages, { userId }).catch((err) => {
    console.warn(`[memory] ingest failed: ${err.message}`);
  });
}
