import type { ContextBuffer } from '../context/context-buffer.js';

export function createPeekHandler(buffer: ContextBuffer) {
  return async (params: Record<string, unknown>) => {
    const offset = (params.offset as number) ?? 0;
    const length = (params.length as number) ?? 50;
    const text = buffer.peek(offset, length);
    return {
      text,
      fromLine: offset,
      toLine: Math.min(offset + length, buffer.lineCount),
      totalLines: buffer.lineCount,
    };
  };
}
