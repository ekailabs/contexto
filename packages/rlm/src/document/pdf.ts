import type { DocumentParser, DocumentChunk } from './types.js';

const PDF_MIME_TYPES = ['application/pdf'];

export class PdfParser implements DocumentParser {
  canParse(mimeType: string): boolean {
    return PDF_MIME_TYPES.includes(mimeType);
  }

  async parse(buffer: Buffer, filename?: string): Promise<DocumentChunk[]> {
    let pdfParse: any;
    try {
      // @ts-ignore — optional peer dependency
      pdfParse = (await import('pdf-parse')).default;
    } catch {
      throw new Error('pdf-parse is not installed. Install it with: npm install pdf-parse');
    }

    const data = await pdfParse(buffer);
    const source = filename ?? 'document.pdf';

    // Split by form feed (page break) if present, otherwise treat as single page
    const pages = data.text.split('\f').filter((p: string) => p.trim());

    if (pages.length <= 1) {
      return [{
        content: data.text,
        metadata: { source, page: 1, index: 0 },
      }];
    }

    return pages.map((page: string, i: number) => ({
      content: page.trim(),
      metadata: { source, page: i + 1, index: i },
    }));
  }
}
