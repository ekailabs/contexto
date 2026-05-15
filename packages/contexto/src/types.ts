export interface BaseConfig {
  apiKey: string;
  contextEnabled?: boolean;

  maxContextChars?: number;
  /** Max number of memory items to retrieve per assemble() call. Default: 7. */
  maxResults?: number;
  /** Minimum similarity score for an item to be considered relevant. Default: 0.45. */
  minScore?: number;
  /**
   * Optional metadata-equality filter merged into the backend search.
   * The engine always pins ``source: 'summary'`` — anything you set here is
   * spread on top, so passing ``{ source: 'episode' }`` switches the kind
   * of items returned. Pass ``{}`` to keep the default.
   */
  filter?: Record<string, unknown>;
  mode?: 'remote' | 'local';
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

/**
 * One memory item carried in a mindmap search result. Matches
 * ``@ekai/mindmap``'s ``ConversationItem`` shape (the storage record),
 * minus the embedding vector which the search layer never echoes back
 * to callers. Re-exposed here so backend implementers (#116) don't
 * have to import from a different package to learn the field names.
 */
export interface MindmapItem {
  id: string;
  role: string;
  content: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
}

/** A search hit: the item + its similarity score + an estimated token cost. */
export interface ScoredMindmapItem {
  item: MindmapItem;
  score: number;
  estimatedTokens: number;
}

/** Shape returned by the mindmap search endpoint (ScoredQueryResult). */
export interface SearchResult {
  items: ScoredMindmapItem[];
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
  error(msg: string): void;
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
