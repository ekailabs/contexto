import type { ContextBuffer } from '../context/context-buffer.js';
import type { CompletionProvider } from '../types.js';

/**
 * Build the set of functions available inside the REPL sandbox.
 * These bridge from the vm isolate back to the host ContextBuffer and CompletionProvider.
 */
export interface REPLBuiltins {
  peek: (offset: number, length?: number) => string;
  grep: (pattern: string, opts?: { regex?: boolean; limit?: number }) => object[];
  slice: (start: number, end: number) => string;
  llm_query: (prompt: string) => Promise<string>;
  len: (x: unknown) => number;
  chunk: (text: string, size: number) => string[];
}

export function createBuiltins(buffer: ContextBuffer, provider: CompletionProvider): REPLBuiltins {
  return {
    peek(offset: number, length: number = 50): string {
      return buffer.peek(offset, length);
    },

    grep(pattern: string, opts?: { regex?: boolean; limit?: number }): object[] {
      return buffer.grep(pattern, opts).map(r => ({
        lineNumber: r.lineNumber,
        line: r.line,
      }));
    },

    slice(start: number, end: number): string {
      return buffer.slice(start, end);
    },

    async llm_query(prompt: string): Promise<string> {
      try {
        return await provider.completionStr(prompt);
      } catch (e) {
        return `Error making LLM query: ${e}`;
      }
    },

    len(x: unknown): number {
      if (typeof x === 'string') return x.length;
      if (Array.isArray(x)) return x.length;
      return 0;
    },

    chunk(text: string, size: number): string[] {
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += size) {
        chunks.push(text.slice(i, i + size));
      }
      return chunks;
    },
  };
}
