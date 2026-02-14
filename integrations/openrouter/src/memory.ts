import { MEMORY_URL } from './config.js';

interface QueryResult {
  sector: 'episodic' | 'semantic' | 'procedural';
  content: string;
  score: number;
  details?: {
    // semantic
    subject?: string;
    predicate?: string;
    object?: string;
    // procedural
    trigger?: string;
    steps?: string[];
    goal?: string;
  };
}

interface SearchResponse {
  workingMemory: QueryResult[];
  perSector: Record<string, QueryResult[]>;
  profileId: string;
}

/**
 * Fetch memory context from the memory service.
 * Returns null on any failure — memory is additive, never blocking.
 */
export async function fetchMemoryContext(
  query: string,
  profile: string,
): Promise<QueryResult[] | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${MEMORY_URL}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, profile }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[memory] search returned ${res.status}`);
      return null;
    }

    const data = (await res.json()) as SearchResponse;
    return data.workingMemory?.length ? data.workingMemory : null;
  } catch (err: any) {
    console.warn(`[memory] search failed: ${err.message}`);
    return null;
  }
}

/**
 * Format memory results into a system message block, grouped by sector.
 */
export function formatMemoryBlock(results: QueryResult[]): string {
  const facts: string[] = [];
  const events: string[] = [];
  const procedures: string[] = [];

  for (const r of results) {
    if (r.sector === 'semantic' && r.details?.subject) {
      facts.push(`- ${r.details.subject} ${r.details.predicate} ${r.details.object}`);
    } else if (r.sector === 'procedural' && r.details?.trigger) {
      const steps = r.details.steps?.join(' → ') || r.content;
      procedures.push(`- When ${r.details.trigger}: ${steps}`);
    } else {
      events.push(`- ${r.content}`);
    }
  }

  const sections: string[] = [];
  if (facts.length) sections.push(`Facts:\n${facts.join('\n')}`);
  if (events.length) sections.push(`Events:\n${events.join('\n')}`);
  if (procedures.length) sections.push(`Procedures:\n${procedures.join('\n')}`);

  return `<memory>\n[Recalled context for this conversation. Use naturally if relevant, ignore if not.]\n\n${sections.join('\n\n')}\n</memory>`;
}

/**
 * Inject a memory block into the messages array.
 * If messages[0] is a system message, prepend memory before existing content.
 * Otherwise, insert a new system message at index 0.
 * Memory goes BEFORE developer instructions so the developer prompt takes priority.
 */
export function injectMemory(
  messages: Array<{ role: string; content: string }>,
  memoryBlock: string,
): void {
  if (messages[0]?.role === 'system') {
    messages[0].content = memoryBlock + '\n\n' + messages[0].content;
  } else {
    messages.unshift({ role: 'system', content: memoryBlock });
  }
}

/**
 * Fire-and-forget: send messages to the memory service for ingestion.
 * Never awaited — failures are logged and swallowed.
 */
export function ingestMessages(
  messages: Array<{ role: string; content: string }>,
  profile: string,
): void {
  fetch(`${MEMORY_URL}/v1/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, profile }),
  }).catch((err) => {
    console.warn(`[memory] ingest failed: ${err.message}`);
  });
}
