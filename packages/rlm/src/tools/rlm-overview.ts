import type { ContextBuffer } from '../context/context-buffer.js';

export function createOverviewHandler(buffer: ContextBuffer) {
  return async (_params: Record<string, unknown>) => {
    const overview = buffer.overview();
    return {
      charCount: overview.charCount,
      lineCount: overview.lineCount,
      sections: overview.sections.map(s => ({
        title: s.title,
        startLine: s.startLine,
        level: s.level,
      })),
      preview: overview.preview,
      metadata: overview.metadata,
    };
  };
}
