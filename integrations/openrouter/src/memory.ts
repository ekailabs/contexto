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

/**
 * Format memory results into a system message block, grouped by sector.
 * Uses agent-voice section names.
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
  if (facts.length) sections.push(`What I know:\n${facts.join('\n')}`);
  if (events.length) sections.push(`What I remember:\n${events.join('\n')}`);
  if (procedures.length) sections.push(`How I do things:\n${procedures.join('\n')}`);

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
