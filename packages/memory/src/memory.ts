import { SqliteMemoryStore } from './sqlite-store.js';
import { embed as defaultEmbed, createEmbedFn } from './providers/embed.js';
import { extract as defaultExtract, createExtractFn } from './providers/extract.js';
import type {
  AgentInfo,
  ExtractFn,
  MemoryFilterOptions,
  MemoryRecord,
  ProviderName,
  QueryResult,
} from './types.js';
import { checkRelevance } from './providers/relevance.js';

export interface MemoryConfig {
  provider?: ProviderName;
  apiKey?: string;
  dbPath?: string;
  embedModel?: string;
  extractModel?: string;
}

export class Memory {
  private store: SqliteMemoryStore;
  private extractFn: ExtractFn;
  private agentId: string | undefined;

  constructor(config?: MemoryConfig) {
    // Build embed/extract functions: use explicit provider config if given, else fall back to env-based
    const embedFn = (config?.provider && config?.apiKey)
      ? createEmbedFn({ provider: config.provider, apiKey: config.apiKey, embedModel: config.embedModel })
      : defaultEmbed;

    this.extractFn = (config?.provider && config?.apiKey)
      ? createExtractFn({ provider: config.provider, apiKey: config.apiKey, extractModel: config.extractModel })
      : defaultExtract;

    this.store = new SqliteMemoryStore({
      dbPath: config?.dbPath ?? './memory.db',
      embed: embedFn,
    });
  }

  /** Create an internal Memory sharing this store, scoped to an agent. */
  private static _scoped(store: SqliteMemoryStore, extractFn: ExtractFn, agentId: string): Memory {
    const m = Object.create(Memory.prototype) as Memory;
    m.store = store;
    m.extractFn = extractFn;
    m.agentId = agentId;
    return m;
  }

  // --- Management (always available) ---

  /** Register an agent. `soul` is optional agent-level context/personality. */
  addAgent(id: string, opts?: { name?: string; soul?: string; relevancePrompt?: string }): AgentInfo {
    return this.store.addAgent(id, { name: opts?.name, soulMd: opts?.soul, relevancePrompt: opts?.relevancePrompt });
  }

  getAgents(): AgentInfo[] {
    return this.store.getAgents();
  }

  /** Return an agent-scoped instance sharing the same store. */
  agent(id: string): Memory {
    return Memory._scoped(this.store, this.extractFn, id);
  }

  // --- Data ops (require agent scope) ---

  private requireAgent(): string {
    if (!this.agentId) {
      throw new Error('agent_scope_required: use mem.agent("id") for data ops');
    }
    return this.agentId;
  }

  /**
   * Add memories from raw conversation messages.
   * Internally calls extract() to pull episodic/semantic/procedural components,
   * then ingests them into the store.
   */
  async add(
    messages: Array<{ role: string; content: string }>,
    opts?: { userId?: string },
  ): Promise<{ stored: number; ids: string[]; filtered?: boolean; reason?: string }> {
    const agent = this.requireAgent();

    const allMessages = messages.filter((m) => m.content?.trim());
    const sourceText = allMessages
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.trim()}`)
      .join('\n\n');

    if (!sourceText) return { stored: 0, ids: [] };

    const agentInfo = this.store.getAgent(agent);
    if (agentInfo?.relevancePrompt) {
      const check = await checkRelevance(sourceText, agentInfo.relevancePrompt);
      if (!check.relevant) {
        return { stored: 0, ids: [], filtered: true, reason: check.reason };
      }
    }

    const components = await this.extractFn(sourceText);
    if (!components) return { stored: 0, ids: [] };

    const rows = await this.store.ingest(components, agent, {
      origin: { originType: 'conversation' },
      userId: opts?.userId,
    });

    return { stored: rows.length, ids: rows.map((r) => r.id) };
  }

  /** Search memories semantically. */
  async search(
    query: string,
    opts?: { userId?: string },
  ): Promise<QueryResult[]> {
    const agent = this.requireAgent();
    const data = await this.store.query(query, agent, opts?.userId);
    return data.workingMemory ?? [];
  }

  /** List users who have memories for this agent. */
  users(): Array<{
    userId: string;
    firstSeen: number;
    lastSeen: number;
    interactionCount: number;
  }> {
    const agent = this.requireAgent();
    return this.store.getAgentUsers(agent);
  }

  /** Get memories, optionally filtered by userId or scope. */
  memories(opts?: MemoryFilterOptions): (MemoryRecord & { details?: any })[] {
    const agent = this.requireAgent();
    const limit = opts?.limit ?? 50;

    if (opts?.scope === 'global') {
      return this.store.getGlobalMemories(agent, limit);
    }
    if (opts?.userId) {
      return this.store.getMemoriesForUser(agent, opts.userId, limit);
    }
    return this.store.getRecent(agent, limit);
  }

  /** Delete a memory by ID. */
  delete(id: string): boolean {
    const agent = this.requireAgent();
    return this.store.deleteById(id, agent) > 0;
  }

  /** Get the underlying store (for advanced use / mounting HTTP routes). */
  get _store(): SqliteMemoryStore {
    return this.store;
  }

  /** Get the extract function (for passing to router/documents). */
  get _extractFn(): ExtractFn {
    return this.extractFn;
  }
}
