import type { ConversationItem, MindmapConfig, MindmapState, QueryResult, EmbedFn, LLMConfig, TreeNode } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { buildMindmap, addToMindmap } from './clustering.js';
import { queryMindmap } from './retrieval.js';
import { createEmbedFn } from './embed.js';
import type { MindmapStorage } from './storage.js';
import { memoryStorage } from './storage.js';

export interface MindmapProviderOptions {
  provider: 'openrouter' | 'openai';
  apiKey: string;
  embedModel?: string;
  llmModel?: string;
  storage?: MindmapStorage;
  config?: Partial<MindmapConfig>;
}

export interface MindmapCustomOptions {
  embedFn: EmbedFn;
  llm?: LLMConfig;
  storage?: MindmapStorage;
  config?: Partial<MindmapConfig>;
}

export type MindmapOptions = MindmapProviderOptions | MindmapCustomOptions;

function isProviderOptions(opts: MindmapOptions): opts is MindmapProviderOptions {
  return 'provider' in opts && 'apiKey' in opts;
}

export class Mindmap {
  private state: MindmapState | null = null;
  private embedFn: EmbedFn;
  private llmConfig?: LLMConfig;
  private storage: MindmapStorage;
  private config: MindmapConfig;
  private initialized = false;

  constructor(options: MindmapOptions) {
    if (isProviderOptions(options)) {
      this.embedFn = createEmbedFn({
        provider: options.provider,
        apiKey: options.apiKey,
        model: options.embedModel,
      });
      this.llmConfig = {
        provider: options.provider,
        apiKey: options.apiKey,
        model: options.llmModel,
      };
    } else {
      this.embedFn = options.embedFn;
      this.llmConfig = options.llm;
    }
    this.storage = options.storage ?? memoryStorage();
    this.config = { ...DEFAULT_CONFIG, ...options.config };
  }

  private async ensureLoaded(): Promise<MindmapState> {
    if (!this.initialized) {
      this.state = await this.storage.load();
      this.initialized = true;
    }

    if (!this.state) {
      this.state = buildMindmap([], this.config);
    }

    return this.state;
  }

  async add(items: Omit<ConversationItem, 'embedding'>[]): Promise<MindmapState> {
    const state = await this.ensureLoaded();

    // Compute embeddings for all items
    const withEmbeddings: ConversationItem[] = await Promise.all(
      items.map(async (item) => ({
        ...item,
        embedding: await this.embedFn(item.content),
      })),
    );

    this.state = addToMindmap(state, withEmbeddings);
    await this.storage.save(this.state);
    return this.state;
  }

  async query(text: string, maxResults?: number): Promise<QueryResult> {
    const state = await this.ensureLoaded();
    const queryEmbedding = await this.embedFn(text);
    return queryMindmap(state, queryEmbedding, maxResults);
  }

  async getState(): Promise<MindmapState> {
    return this.ensureLoaded();
  }

  async toTree(options?: { detailed?: boolean }): Promise<TreeNode> {
    const { toTree } = await import('./tree.js');
    const state = await this.ensureLoaded();
    return toTree(state, options);
  }

  async toTreeLLM(): Promise<TreeNode> {
    if (!this.llmConfig) {
      return this.toTree();
    }
    const { toTreeLLM } = await import('./tree.js');
    const state = await this.ensureLoaded();
    return toTreeLLM(state, this.llmConfig);
  }
}

export function createMindmap(options: MindmapOptions): Mindmap {
  return new Mindmap(options);
}
