import type { ContextBuffer } from '../context/context-buffer.js';

export function createGrepHandler(buffer: ContextBuffer) {
  return async (params: Record<string, unknown>) => {
    const pattern = params.pattern as string;
    const regex = (params.regex as boolean) ?? false;
    const limit = (params.limit as number) ?? 20;

    const results = buffer.grep(pattern, { regex, limit });
    return {
      matchCount: results.length,
      matches: results.map(r => ({
        lineNumber: r.lineNumber,
        line: r.line,
        context: r.context.join('\n'),
      })),
    };
  };
}
