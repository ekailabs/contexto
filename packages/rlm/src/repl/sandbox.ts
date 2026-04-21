import vm from 'node:vm';
import type { REPLBuiltins } from './builtins.js';
import { validateCode } from './code-validator.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 20_000;
const MAX_ITERATIONS = 20;

/** Result from a single REPL code execution. */
export interface REPLResult {
  output: string;
  error?: string;
  finalAnswer?: string;
  variables: Record<string, string>;
  executionTimeMs: number;
}

/**
 * REPL sandbox using Node.js vm module.
 *
 * Provides the agent with a JavaScript execution environment that has access
 * to the context buffer (via builtins), sub-LLM calls (via llm_query),
 * and variable persistence across calls (via store/get).
 *
 * Note: Node's vm module is NOT a security sandbox. The code validator
 * provides defense-in-depth, not absolute isolation.
 */
export class REPLSandbox {
  private context: vm.Context | null = null;
  private builtins: REPLBuiltins;
  private contextContent: string;
  private output: string[] = [];
  private variables = new Map<string, string>();
  private iterationCount = 0;
  private finalAnswer: string | null = null;
  private timeoutMs: number;

  constructor(
    builtins: REPLBuiltins,
    contextContent: string,
    opts?: { timeoutMs?: number },
  ) {
    this.builtins = builtins;
    this.contextContent = contextContent;
    this.timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async initialize(): Promise<void> {
    const self = this;

    const sandbox: Record<string, unknown> = {
      // The loaded context
      context: this.contextContent,

      // Console
      print: (...args: unknown[]) => {
        const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        self.output.push(line);
      },
      console: {
        log: (...args: unknown[]) => {
          const line = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
          self.output.push(line);
        },
      },

      // Variable persistence across REPL calls
      store: (name: string, value: unknown) => {
        self.variables.set(name, typeof value === 'string' ? value : JSON.stringify(value));
      },
      get: (name: string) => {
        const v = self.variables.get(name);
        if (v === undefined) return null;
        try { return JSON.parse(v); } catch { return v; }
      },

      // Completion signals
      FINAL: (value: unknown) => {
        self.finalAnswer = typeof value === 'string' ? value : JSON.stringify(value);
      },
      FINAL_VAR: (name: string) => {
        const val = self.variables.get(name);
        if (val !== undefined) {
          self.finalAnswer = val;
          return val;
        }
        return `Error: Variable '${name}' not found. Available: ${[...self.variables.keys()].join(', ')}`;
      },

      // Context buffer builtins
      peek: (offset: number, length?: number) => self.builtins.peek(offset, length),
      grep: (pattern: string, opts?: object) => self.builtins.grep(pattern, opts as any),
      slice: (start: number, end: number) => self.builtins.slice(start, end),
      llm_query: async (prompt: string) => self.builtins.llm_query(prompt),

      // Utility
      len: self.builtins.len,
      chunk: self.builtins.chunk,

      // Standard JS builtins
      JSON, Math, Date, Array, Object, String, Number, Boolean,
      Map, Set, RegExp, Promise,
      parseInt, parseFloat, isNaN, isFinite,
      encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
      Error, TypeError, RangeError, SyntaxError,
      undefined, NaN, Infinity,

      // Blocked
      setTimeout: undefined,
      setInterval: undefined,
    };

    this.context = vm.createContext(sandbox, {
      codeGeneration: { strings: false, wasm: false },
    });
  }

  async runCode(code: string): Promise<REPLResult> {
    if (!this.context) {
      return {
        output: 'Error: Sandbox not initialized. Call initialize() first.',
        error: 'Sandbox not initialized',
        variables: Object.fromEntries(this.variables),
        executionTimeMs: 0,
      };
    }

    if (this.iterationCount >= MAX_ITERATIONS) {
      return {
        output: `Error: Maximum iterations (${MAX_ITERATIONS}) reached.`,
        error: 'Max iterations exceeded',
        variables: Object.fromEntries(this.variables),
        executionTimeMs: 0,
      };
    }

    const validation = validateCode(code);
    if (!validation.valid) {
      return {
        output: `Code rejected: ${validation.reason}`,
        error: validation.reason,
        variables: Object.fromEntries(this.variables),
        executionTimeMs: 0,
      };
    }

    this.iterationCount++;
    this.output = [];
    this.finalAnswer = null;
    const startTime = Date.now();

    try {
      const wrappedCode = `(async () => { ${code} })()`;
      const script = new vm.Script(wrappedCode);
      const promise = script.runInContext(this.context, { timeout: this.timeoutMs });
      await promise;

      const rawOutput = this.output.join('\n');
      const output = rawOutput.length > MAX_OUTPUT_CHARS
        ? rawOutput.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated, ${rawOutput.length - MAX_OUTPUT_CHARS} chars omitted]`
        : rawOutput;

      return {
        output,
        finalAnswer: this.finalAnswer ?? undefined,
        variables: Object.fromEntries(this.variables),
        executionTimeMs: Date.now() - startTime,
      };
    } catch (err) {
      const message = `${err}`;

      return {
        output: this.output.join('\n'),
        error: message,
        variables: Object.fromEntries(this.variables),
        executionTimeMs: Date.now() - startTime,
      };
    }
  }

  getFinalAnswer(): string | null {
    return this.finalAnswer;
  }

  getIterationCount(): number {
    return this.iterationCount;
  }

  dispose(): void {
    this.context = null;
  }
}
