import type { Section, OverviewResult, ContextChunk, GrepResult } from './types.js';

const PREVIEW_LINES = 20;
const DEFAULT_GREP_LIMIT = 20;
const GREP_CONTEXT_LINES = 2;

// Markdown-style header patterns for section detection
const HEADER_RE = /^(#{1,6})\s+(.+)/;
const PAGE_BREAK_RE = /^-{3,}$|^={3,}$|^\f/;

/**
 * ContextBuffer — holds large text and provides structured access.
 *
 * All RLM tools delegate to this. The buffer is ephemeral — it exists
 * only for the subagent's lifetime. No persistence needed.
 */
export class ContextBuffer {
  private content: string;
  private lines: string[];
  private sections: Section[];
  private meta?: { filename?: string; mimeType?: string };

  constructor(content: string, metadata?: { filename?: string; mimeType?: string }) {
    this.content = content;
    this.lines = content.split('\n');
    this.meta = metadata;
    this.sections = this.detectSections();
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get charCount(): number {
    return this.content.length;
  }

  /** Get the raw content string. */
  getRawContent(): string {
    return this.content;
  }

  /** Structural overview: line count, char count, detected sections, preview. */
  overview(): OverviewResult {
    return {
      charCount: this.content.length,
      lineCount: this.lines.length,
      sections: this.sections,
      preview: this.lines.slice(0, PREVIEW_LINES).join('\n'),
      metadata: this.meta,
    };
  }

  /** View lines at offset from start. */
  peek(offset: number, length: number = 50): string {
    const start = Math.max(0, offset);
    const end = Math.min(this.lines.length, start + length);
    return this.lines.slice(start, end).join('\n');
  }

  /** Search by substring or regex, returns matching lines with context. */
  grep(pattern: string, opts?: { regex?: boolean; limit?: number }): GrepResult[] {
    const limit = opts?.limit ?? DEFAULT_GREP_LIMIT;
    const results: GrepResult[] = [];

    let matcher: (line: string) => boolean;
    if (opts?.regex) {
      try {
        const re = new RegExp(pattern, 'i');
        matcher = (line) => re.test(line);
      } catch {
        // Invalid regex — fall back to substring
        matcher = (line) => line.toLowerCase().includes(pattern.toLowerCase());
      }
    } else {
      const lower = pattern.toLowerCase();
      matcher = (line) => line.toLowerCase().includes(lower);
    }

    for (let i = 0; i < this.lines.length && results.length < limit; i++) {
      if (matcher(this.lines[i])) {
        const ctxStart = Math.max(0, i - GREP_CONTEXT_LINES);
        const ctxEnd = Math.min(this.lines.length, i + GREP_CONTEXT_LINES + 1);
        results.push({
          lineNumber: i,
          line: this.lines[i],
          context: this.lines.slice(ctxStart, ctxEnd),
        });
      }
    }

    return results;
  }

  /** Extract contiguous line range. */
  slice(start: number, end: number): string {
    const s = Math.max(0, start);
    const e = Math.min(this.lines.length, end);
    return this.lines.slice(s, e).join('\n');
  }

  /** Get a chunk suitable for sub-LLM query (respects char budget). */
  getChunk(start: number, maxChars: number): ContextChunk {
    const s = Math.max(0, start);
    let charCount = 0;
    let endLine = s;

    for (let i = s; i < this.lines.length; i++) {
      const lineLen = this.lines[i].length + 1; // +1 for newline
      if (charCount + lineLen > maxChars && i > s) break;
      charCount += lineLen;
      endLine = i + 1;
    }

    return {
      content: this.lines.slice(s, endLine).join('\n'),
      startLine: s,
      endLine,
      charCount,
    };
  }

  /** Detect structural sections (markdown headers, page breaks). */
  private detectSections(): Section[] {
    const sections: Section[] = [];
    let currentSection: Section | null = null;

    for (let i = 0; i < this.lines.length; i++) {
      const headerMatch = this.lines[i].match(HEADER_RE);
      if (headerMatch) {
        if (currentSection) {
          currentSection.endLine = i - 1;
          sections.push(currentSection);
        }
        currentSection = {
          title: headerMatch[2].trim(),
          startLine: i,
          endLine: this.lines.length - 1,
          level: headerMatch[1].length,
        };
      } else if (PAGE_BREAK_RE.test(this.lines[i]) && currentSection) {
        currentSection.endLine = i - 1;
        sections.push(currentSection);
        currentSection = null;
      }
    }

    if (currentSection) {
      sections.push(currentSection);
    }

    return sections;
  }
}
