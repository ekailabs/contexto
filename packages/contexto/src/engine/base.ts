import type { ContextEngine, ContextEngineInfo } from 'openclaw/plugin-sdk';
import type { ContextoBackend, Logger, BaseConfig } from '../types.js';
import { stripMetadataEnvelope, formatSearchResults, assembleContextMessages } from '../helpers.js';
import type {
  CompactionState,
  BootstrapParams, BootstrapResult,
  IngestParams, IngestBatchParams,
  AfterTurnParams,
  AssembleParams, AssembleResult,
  CompactParams, CompactResult,
  SubagentSpawnParams, SubagentEndedParams,
} from './types.js';

const DEFAULT_MAX_CONTEXT_CHARS = 2000;
const DEFAULT_MAX_RESULTS = 7;
const DEFAULT_MIN_SCORE = 0.45;

/**
 * Abstract base class for context engine implementations.
 * Provides default implementations for shared lifecycle methods (assemble, bootstrap, no-ops).
 * Concrete engines extend this and override strategy-specific methods (afterTurn, compact, dispose).
 */
export abstract class AbstractContextEngine implements ContextEngine {
  protected state: CompactionState;
  protected config: BaseConfig;
  protected backend: ContextoBackend;
  protected logger: Logger;

  abstract readonly ownsCompaction: boolean;

  get info(): ContextEngineInfo {
    return {
      id: 'contexto',
      name: 'Contexto',
      ownsCompaction: this.ownsCompaction,
    };
  }

  constructor(state: CompactionState, config: BaseConfig, backend: ContextoBackend, logger: Logger) {
    this.state = state;
    this.config = config;
    this.backend = backend;
    this.logger = logger;
  }

  // --- Default implementations (shared) ---

  async bootstrap(_params: BootstrapParams): Promise<BootstrapResult> {
    return { bootstrapped: false, importedMessages: 0, reason: 'not applicable' };
  }

  async ingest(_params: IngestParams): Promise<{ ingested: boolean }> {
    return { ingested: false };
  }

  async ingestBatch(_params: IngestBatchParams): Promise<{ ingestedCount: number }> {
    return { ingestedCount: 0 };
  }

  async assemble(params: AssembleParams): Promise<AssembleResult> {
    const { messages, tokenBudget } = params;

    // Cache tokenBudget for threshold evaluation
    if (tokenBudget != null) this.state.cachedTokenBudget = tokenBudget;

    const lastMsg = messages?.[messages.length - 1];
    this.logger.info(`[contexto] assemble() called — ${messages?.length} messages, tokenBudget: ${tokenBudget}, contextEnabled: ${this.config.contextEnabled}, hasApiKey: ${!!this.config.apiKey}`);
    this.logger.debug(`[contexto] last message — role: ${lastMsg?.role}, content type: ${typeof lastMsg?.content}, isArray: ${Array.isArray(lastMsg?.content)}, sample: ${JSON.stringify(lastMsg?.content)?.slice(0, 200)}`);

    if (!this.config.apiKey || !this.config.contextEnabled) {
      this.logger.info(`[contexto] assemble() skipping — apiKey: ${!!this.config.apiKey}, contextEnabled: ${this.config.contextEnabled}`);
      return { messages, estimatedTokens: 0 };
    }

    const query = params.prompt ? stripMetadataEnvelope(params.prompt) : undefined;
    if (!query) {
      return { messages, estimatedTokens: 0 };
    }

    const maxChars = tokenBudget
      ? Math.floor(tokenBudget * 0.1 * 4)
      : (this.config.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS);

    this.logger.info(`[contexto] Fetching context for query: "${query.slice(0, 100)}"`);
    const filter = { source: 'summary', ...this.config.filter };
    const minScore = this.config.minScore ?? DEFAULT_MIN_SCORE;
    const result = await this.backend.search(query, DEFAULT_MAX_RESULTS, filter, minScore);

    if (!result?.items?.length) {
      return { messages, estimatedTokens: 0 };
    }

    const itemSummary = result.items.map((r: any, i: number) => `[${i}] ${r.item?.content?.length ?? 0} chars`).join(', ');
    this.logger.info(`[contexto] Mindmap returned ${result.items.length} items (${itemSummary}), paths: ${JSON.stringify(result.paths)}`);

    // Deduplicate: filter out items already injected in this session
    const filtered = result.items.filter((r: any) => {
      const id = (r.item ?? r).id;
      return !id || !this.state.injectedItemIds.has(id);
    });

    if (filtered.length < result.items.length) {
      this.logger.info(`[contexto] Dedup: ${result.items.length} results -> ${filtered.length} after dedup (${result.items.length - filtered.length} suppressed)`);
    }

    if (!filtered.length) {
      return { messages, estimatedTokens: 0 };
    }

    // Record injected item IDs
    for (const r of filtered) {
      const id = (r.item ?? r).id;
      if (id) this.state.injectedItemIds.add(id);
    }

    let context = formatSearchResults(filtered);

    if (context.length > maxChars) {
      context = context.slice(0, maxChars) + '…';
    }

    this.logger.info(`[contexto] Injecting ${context.length} chars of context`);

    return assembleContextMessages(context, messages);
  }

  async prepareSubagentSpawn(_params: SubagentSpawnParams): Promise<undefined> {
    return undefined;
  }

  async onSubagentEnded(_params: SubagentEndedParams): Promise<void> {}

  // --- Template method with apiKey guard ---

  async afterTurn(params: AfterTurnParams): Promise<void> {
    if (!this.config.apiKey) return;
    this.handleAfterTurn(params);
  }

  // --- Abstract methods (strategy-specific) ---

  protected abstract handleAfterTurn(params: AfterTurnParams): void;
  abstract compact(params: CompactParams): Promise<CompactResult>;
  abstract dispose(): Promise<void>;
}
