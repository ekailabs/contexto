import type { DocumentParser, DocumentChunk } from './types.js';

const EXCEL_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

export class ExcelParser implements DocumentParser {
  canParse(mimeType: string): boolean {
    return EXCEL_MIME_TYPES.includes(mimeType);
  }

  async parse(buffer: Buffer, filename?: string): Promise<DocumentChunk[]> {
    let XLSX: any;
    try {
      // @ts-ignore — optional peer dependency
      XLSX = await import('xlsx');
    } catch {
      throw new Error('xlsx is not installed. Install it with: npm install xlsx');
    }

    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const source = filename ?? 'document.xlsx';
    const chunks: DocumentChunk[] = [];

    for (let i = 0; i < workbook.SheetNames.length; i++) {
      const sheetName = workbook.SheetNames[i];
      const sheet = workbook.Sheets[sheetName];
      const csv = XLSX.utils.sheet_to_csv(sheet);

      if (csv.trim()) {
        chunks.push({
          content: `Sheet: ${sheetName}\n${csv}`,
          metadata: { source, sheet: sheetName, index: i },
        });
      }
    }

    return chunks;
  }
}
