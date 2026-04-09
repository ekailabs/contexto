// Core
export { ContextBuffer } from './context/context-buffer.js';

// Tools — definitions + handler factories
export {
  RLM_OVERVIEW_DEFINITION,
  RLM_PEEK_DEFINITION,
  RLM_GREP_DEFINITION,
  RLM_SLICE_DEFINITION,
  RLM_QUERY_DEFINITION,
  RLM_REPL_DEFINITION,
  ALL_RLM_DEFINITIONS,
} from './tools/definitions.js';
export { createOverviewHandler } from './tools/rlm-overview.js';
export { createPeekHandler } from './tools/rlm-peek.js';
export { createGrepHandler } from './tools/rlm-grep.js';
export { createSliceHandler } from './tools/rlm-slice.js';
export { createQueryHandler } from './tools/rlm-query.js';
export { createReplHandler } from './tools/rlm-repl.js';

// REPL internals (for advanced use)
export { REPLSandbox } from './repl/sandbox.js';
export type { REPLResult } from './repl/sandbox.js';

// Document parsing
export { parseDocument } from './document/index.js';

// Types
export type { CompletionProvider, Message, Context } from './types.js';
export type { ContextChunk, OverviewResult, GrepResult, Section } from './context/types.js';
export type { DocumentParser, DocumentChunk } from './document/types.js';
