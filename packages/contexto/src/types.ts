export interface BaseConfig {
  apiKey: string;
  contextEnabled: boolean;
  maxContextChars?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  backend?: 'remote' | 'local';
  storagePath?: string;
}

export interface DefaultConfig extends BaseConfig {
  compactionStrategy: 'default';
}

export interface SlidingWindowConfig extends BaseConfig {
  compactionStrategy?: 'sliding-window';  // default
  compactThreshold?: number;  // ingest + evict at this % of budget (default: 0.50)
}

export type PluginConfig = DefaultConfig | SlidingWindowConfig;

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
  /** Store one or more conversation events. */
  ingest(payload: WebhookPayload | WebhookPayload[]): Promise<void>;
  /** Search the mindmap for context relevant to the query. */
  search(query: string, maxResults: number, filter?: Record<string, unknown>, minScore?: number): Promise<SearchResult | null>;
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
