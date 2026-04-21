/** A detected structural section in the context (e.g., markdown header, page break). */
export interface Section {
  title: string;
  startLine: number;
  endLine: number;
  level: number;
}

/** Structural overview of the loaded context. */
export interface OverviewResult {
  charCount: number;
  lineCount: number;
  sections: Section[];
  preview: string;
  metadata?: { filename?: string; mimeType?: string };
}

/** A chunk extracted from the context with position metadata. */
export interface ContextChunk {
  content: string;
  startLine: number;
  endLine: number;
  charCount: number;
}

/** A grep match with line number and surrounding context. */
export interface GrepResult {
  lineNumber: number;
  line: string;
  context: string[];
}
