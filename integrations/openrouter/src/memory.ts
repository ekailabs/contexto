import { MEMORY_URL } from './config.js';

interface QueryResult {
  sector: 'episodic' | 'semantic' | 'procedural' | 'reflective';
  content: string;
  score: number;
  details?: {
    // semantic
    subject?: string;
    predicate?: string;
    object?: string;
    domain?: string;
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
  userId?: string,
): Promise<QueryResult[] | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const res = await fetch(`${MEMORY_URL}/v1/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, profile, userId }),
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
 * Uses agent-voice section names.
 */
export function formatMemoryBlock(results: QueryResult[]): string {
  const facts: string[] = [];
  const events: string[] = [];
  const procedures: string[] = [];
  const observations: string[] = [];

  for (const r of results) {
    if (r.sector === 'semantic' && r.details?.subject) {
      facts.push(`- ${r.details.subject} ${r.details.predicate} ${r.details.object}`);
    } else if (r.sector === 'procedural' && r.details?.trigger) {
      const steps = r.details.steps?.join(' → ') || r.content;
      procedures.push(`- When ${r.details.trigger}: ${steps}`);
    } else if (r.sector === 'reflective') {
      observations.push(`- ${r.content}`);
    } else {
      events.push(`- ${r.content}`);
    }
  }

  const sections: string[] = [];
  if (facts.length) sections.push(`What I know:\n${facts.join('\n')}`);
  if (events.length) sections.push(`What I remember:\n${events.join('\n')}`);
  if (procedures.length) sections.push(`How I do things:\n${procedures.join('\n')}`);
  if (observations.length) sections.push(`My observations:\n${observations.join('\n')}`);

  return `<memory>\n[Recalled context for this conversation. Use naturally if relevant, ignore if not.]\n\n${sections.join('\n\n')}\n</memory>`;
}

/**
 * Return a new messages array with memory injected.
 * Memory is placed before the developer system prompt so the developer instructions
 * appear last and take priority (LLM recency bias).
 * Returns the original array unchanged if memoryBlock is empty.
 */
export function injectMemory(
  messages: Array<{ role: string; content: string }>,
  memoryBlock: string,
): Array<{ role: string; content: string }> {
  if (!memoryBlock) return messages;

  if (messages[0]?.role === 'system') {
    return [
      { ...messages[0], content: memoryBlock + '\n\n' + messages[0].content },
      ...messages.slice(1),
    ];
  }
  return [{ role: 'system', content: memoryBlock }, ...messages];
}
