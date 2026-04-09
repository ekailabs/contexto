import type { ContextBuffer } from '../context/context-buffer.js';
import type { CompletionProvider } from '../types.js';

const MAX_CHUNK_CHARS = 500_000;

export function createQueryHandler(buffer: ContextBuffer, provider: CompletionProvider) {
  return async (params: Record<string, unknown>) => {
    const question = params.question as string;
    const start = (params.start as number) ?? 0;
    const end = (params.end as number) ?? buffer.lineCount;

    const chunk = buffer.getChunk(start, MAX_CHUNK_CHARS);
    const sliced = start === 0 && end >= buffer.lineCount
      ? chunk.content
      : buffer.slice(start, end);

    const context = sliced.length > MAX_CHUNK_CHARS
      ? sliced.slice(0, MAX_CHUNK_CHARS) + '\n... [truncated]'
      : sliced;

    const answer = await provider.completionStr(
      `Answer this question based on the context below. Be thorough and cite specific details from the context.\n\nQuestion: ${question}\n\nContext (lines ${start}-${end}):\n${context}`
    );

    return {
      answer,
      linesAnalyzed: { start, end: Math.min(end, buffer.lineCount) },
      chunkChars: context.length,
    };
  };
}
