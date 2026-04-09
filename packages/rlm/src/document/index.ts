import type { DocumentParser, DocumentChunk } from './types.js';
import { PdfParser } from './pdf.js';
import { ExcelParser } from './excel.js';
import { TextParser } from './text.js';

const parsers: DocumentParser[] = [
  new PdfParser(),
  new ExcelParser(),
  new TextParser(),
];

/**
 * Parse a document buffer into text, dispatching to the right parser based on MIME type.
 * Returns concatenated text from all chunks, ready to be loaded into a ContextBuffer.
 */
export async function parseDocument(
  buffer: Buffer,
  mimeType: string,
  filename?: string,
): Promise<string> {
  const parser = parsers.find(p => p.canParse(mimeType));
  if (!parser) {
    // Fall back to treating as plain text
    return buffer.toString('utf-8');
  }

  const chunks = await parser.parse(buffer, filename);
  return chunks.map(c => c.content).join('\n\n');
}

export type { DocumentParser, DocumentChunk };
