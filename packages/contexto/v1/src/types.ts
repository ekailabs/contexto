export interface PluginConfig {
  apiKey: string;
  contextEnabled: boolean;
  maxContextChars?: number;
  filter?: Record<string, unknown>;
}

export interface WebhookPayload {
  event: {
    type: string;
    action: string;
  };
  sessionKey: string;
  timestamp: string;
  context: Record<string, unknown>;
  agent?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/** Shape returned by the mindmap search endpoint (ScoredQueryResult). */
export interface SearchResult {
  items: any[];
  paths?: string[][];
}

/**
 * Backend interface for conversation storage and retrieval.
 * Implement this to swap between remote (api.getcontexto.com) and local backends.
 */
export interface ContextoBackend {
  /** Store a conversation event (user message or LLM output). */
  ingest(payload: WebhookPayload): Promise<void>;
  /** Search the mindmap for context relevant to the query. */
  search(query: string, sessionKey: string, maxResults: number, filter?: Record<string, unknown>): Promise<SearchResult | null>;
}

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
}

export interface ContentBlock {
  type: string;
  text: string;
}

export interface Message {
  role: string;
  content: string | ContentBlock[];
}
