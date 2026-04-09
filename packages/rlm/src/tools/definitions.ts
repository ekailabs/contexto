export const RLM_OVERVIEW_DEFINITION = {
  name: 'rlm_overview',
  description: 'Get structural overview of the loaded context — size, line count, detected sections, and a preview of the beginning',
  parameters: {
    type: 'object' as const,
    properties: {},
  },
};

export const RLM_PEEK_DEFINITION = {
  name: 'rlm_peek',
  description: 'View lines from the context at a given offset',
  parameters: {
    type: 'object' as const,
    properties: {
      offset: { type: 'number', description: 'Line offset from start (0-indexed)' },
      length: { type: 'number', description: 'Number of lines to return (default: 50)' },
    },
    required: ['offset'],
  },
};

export const RLM_GREP_DEFINITION = {
  name: 'rlm_grep',
  description: 'Search the context for a pattern (substring or regex)',
  parameters: {
    type: 'object' as const,
    properties: {
      pattern: { type: 'string', description: 'Search query or regex pattern' },
      regex: { type: 'boolean', description: 'Treat pattern as regex (default: false)' },
      limit: { type: 'number', description: 'Max results (default: 20)' },
    },
    required: ['pattern'],
  },
};

export const RLM_SLICE_DEFINITION = {
  name: 'rlm_slice',
  description: 'Extract a contiguous range of lines from the context',
  parameters: {
    type: 'object' as const,
    properties: {
      start: { type: 'number', description: 'Start line (inclusive, 0-indexed)' },
      end: { type: 'number', description: 'End line (exclusive)' },
    },
    required: ['start', 'end'],
  },
};

export const RLM_QUERY_DEFINITION = {
  name: 'rlm_query',
  description: 'Ask a question about a portion of the context — dispatches to a cheap sub-LLM with the relevant chunk',
  parameters: {
    type: 'object' as const,
    properties: {
      question: { type: 'string', description: 'Question to answer from context' },
      start: { type: 'number', description: 'Start line of chunk to analyze (default: 0)' },
      end: { type: 'number', description: 'End line of chunk (default: entire context up to budget)' },
    },
    required: ['question'],
  },
};

export const RLM_REPL_DEFINITION = {
  name: 'rlm_repl',
  description: 'Run JavaScript in a sandboxed REPL with access to the full context, all retrieval functions (peek, grep, slice, llm_query), and variable persistence (store/get). Use FINAL(answer) or FINAL_VAR(name) to return results. The context variable holds the loaded text.',
  parameters: {
    type: 'object' as const,
    properties: {
      code: { type: 'string', description: 'JavaScript code to execute in the sandbox' },
    },
    required: ['code'],
  },
};

export const ALL_RLM_DEFINITIONS = [
  RLM_OVERVIEW_DEFINITION,
  RLM_PEEK_DEFINITION,
  RLM_GREP_DEFINITION,
  RLM_SLICE_DEFINITION,
  RLM_QUERY_DEFINITION,
  RLM_REPL_DEFINITION,
];
