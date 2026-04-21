import type { DocumentParser, DocumentChunk } from './types.js';

const TEXT_MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/tab-separated-values',
  'application/json',
];

export class TextParser implements DocumentParser {
  canParse(mimeType: string): boolean {
    return TEXT_MIME_TYPES.includes(mimeType) || mimeType.startsWith('text/');
  }

  async parse(buffer: Buffer, filename?: string): Promise<DocumentChunk[]> {
    const content = buffer.toString('utf-8');
    const source = filename ?? 'document.txt';

    return [{
      content,
      metadata: { source, index: 0 },
    }];
  }
}
