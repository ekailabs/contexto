import type { ContextBuffer } from '../context/context-buffer.js';
import type { CompletionProvider } from '../types.js';
import { REPLSandbox } from '../repl/sandbox.js';
import { createBuiltins } from '../repl/builtins.js';

/**
 * Creates a handler for the rlm_repl tool.
 * Runs JavaScript code in the REPL sandbox with access to context and all builtins.
 * Sandbox persists across calls within a session for variable persistence.
 */
export function createReplHandler(buffer: ContextBuffer, provider: CompletionProvider) {
  let sandbox: REPLSandbox | null = null;

  return async (params: Record<string, unknown>) => {
    const code = params.code as string;
    if (!code || typeof code !== 'string') {
      return { output: 'Error: code parameter is required (string)', error: 'missing code' };
    }

    // Lazy init sandbox
    if (!sandbox) {
      const builtins = createBuiltins(buffer, provider);
      sandbox = new REPLSandbox(builtins, buffer.getRawContent(), { timeoutMs: 30_000 });
      await sandbox.initialize();
    }

    const result = await sandbox.runCode(code);

    const parts: string[] = [];
    if (result.output) parts.push(result.output);
    if (result.error) parts.push(`Error: ${result.error}`);
    if (result.finalAnswer) parts.push(`FINAL: ${result.finalAnswer}`);

    const vars = Object.keys(result.variables);
    if (vars.length > 0) parts.push(`Variables: ${vars.join(', ')}`);

    return {
      output: parts.join('\n') || 'No output',
      finalAnswer: result.finalAnswer,
      executionTimeMs: result.executionTimeMs,
      iteration: sandbox.getIterationCount(),
    };
  };
}
