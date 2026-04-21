import type { ContextBuffer } from '../context/context-buffer.js';

export function createSliceHandler(buffer: ContextBuffer) {
  return async (params: Record<string, unknown>) => {
    const start = params.start as number;
    const end = params.end as number;
    const text = buffer.slice(start, end);
    return {
      text,
      fromLine: Math.max(0, start),
      toLine: Math.min(end, buffer.lineCount),
      charCount: text.length,
    };
  };
}
