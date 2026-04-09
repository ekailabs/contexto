export interface DocumentChunk {
  content: string;
  metadata: {
    source: string;
    page?: number;
    sheet?: string;
    index: number;
  };
}

export interface DocumentParser {
  canParse(mimeType: string): boolean;
  parse(buffer: Buffer, filename?: string): Promise<DocumentChunk[]>;
}
