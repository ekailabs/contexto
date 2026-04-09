import type {
  ContextEngine, ContextEngineInfo,
  AssembleResult, BootstrapResult, CompactResult,
  IngestResult, IngestBatchResult, SubagentSpawnPreparation,
} from 'openclaw/plugin-sdk';
import type { ContextoBackend, Logger, BaseConfig } from '../types.js';
import { stripMetadataEnvelope, formatSearchResults, assembleContextMessages, buildPayload } from '../helpers.js';
import type {
  CompactionState, PendingContext,
  BootstrapParams, IngestParams, IngestBatchParams,
  AfterTurnParams, AssembleParams,
  CompactParams, SubagentSpawnParams, SubagentEndedParams,
} from './types.js';

const DEFAULT_MAX_CONTEXT_CHARS = 2000;
const DEFAULT_MAX_RESULTS = 7;
const DEFAULT_MIN_SCORE = 0.45;
const RLM_CONTEXT_THRESHOLD = 0.5;

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

  async ingest(_params: IngestParams): Promise<IngestResult> {
    return { ingested: false };
  }

  async ingestBatch(_params: IngestBatchParams): Promise<IngestBatchResult> {
    return { ingestedCount: 0 };
  }

  async assemble(params: AssembleParams): Promise<AssembleResult> {
    const { messages, tokenBudget } = params;

    // Cache tokenBudget for threshold evaluation
    if (tokenBudget != null) this.state.cachedTokenBudget = tokenBudget;

    const lastMsg = messages?.[messages.length - 1];
    this.logger.info(`[contexto] assemble() called — ${messages?.length} messages, tokenBudget: ${tokenBudget}, contextEnabled: ${this.config.contextEnabled}, hasApiKey: ${!!this.config.apiKey}`);
    const lastMsgContent = lastMsg && 'content' in lastMsg ? lastMsg.content : undefined;
    this.logger.debug(`[contexto] last message — role: ${lastMsg?.role}, content type: ${typeof lastMsgContent}, isArray: ${Array.isArray(lastMsgContent)}, sample: ${JSON.stringify(lastMsgContent)?.slice(0, 200)}`);

    if (!this.config.apiKey || !this.config.contextEnabled) {
      this.logger.info(`[contexto] assemble() skipping — apiKey: ${!!this.config.apiKey}, contextEnabled: ${this.config.contextEnabled}`);
      return { messages, estimatedTokens: 0 };
    }

    // --- RLM: detect large user context ---
    if (this.config.rlmEnabled && tokenBudget && lastMsg?.role === 'user') {
      const userText = this.extractMessageText(lastMsg);
      if (userText) {
        const estimatedTokens = Math.ceil(userText.length / 4);
        const threshold = Math.floor(tokenBudget * RLM_CONTEXT_THRESHOLD);

        if (estimatedTokens > threshold) {
          const sessionKey = (params as any).sessionKey ?? (params as any).sessionId ?? 'default';
          this.state.pendingLargeContext.set(sessionKey, {
            content: userText,
            tokenEstimate: estimatedTokens,
          });
          this.logger.info(`[contexto] RLM: large context detected (${userText.length} chars, ~${estimatedTokens} tokens, threshold: ${threshold}). Stored pending context for session ${sessionKey}`);

          // Replace the large user message with an instruction
          const replacement = `[Large context provided — ${userText.length} chars, ~${estimatedTokens} tokens. Use the rlm_query tool to analyze it.]`;
          const modifiedMessages = [
            ...messages.slice(0, -1),
            { ...lastMsg, content: replacement },
          ];

          return {
            messages: modifiedMessages,
            estimatedTokens: Math.ceil(replacement.length / 4),
            systemPromptAddition: 'The user has provided a large context that exceeds the context window. Use the RLM tools (rlm_overview, rlm_peek, rlm_grep, rlm_slice, rlm_query, rlm_repl) to analyze it. Start with rlm_overview to understand the structure, then use other tools to answer the user\'s question.',
          };
        }
      }
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

  async prepareSubagentSpawn(params: SubagentSpawnParams): Promise<SubagentSpawnPreparation | undefined> {
    const childSessionKey = (params as any).childSessionKey;
    if (!childSessionKey) return undefined;

    // Check if there's a pending large context for the current session
    // The parent session key is stored when assemble() detects large content
    for (const [sessionKey, pending] of this.state.pendingLargeContext.entries()) {
      // Map child session to parent so onSubagentEnded can find the context
      this.state.activeRlmSessions.set(childSessionKey, sessionKey);
      this.logger.info(`[contexto] prepareSubagentSpawn: mapped child ${childSessionKey} → parent ${sessionKey} (${pending.tokenEstimate} est. tokens)`);

      return {
        rollback: () => {
          this.state.activeRlmSessions.delete(childSessionKey);
          this.logger.info(`[contexto] prepareSubagentSpawn rollback: removed child ${childSessionKey}`);
        },
      };
    }

    return undefined;
  }

  async onSubagentEnded(params: SubagentEndedParams): Promise<void> {
    const childSessionKey = (params as any).childSessionKey;
    const result = (params as any).result;
    if (!childSessionKey) return;

    const parentSessionKey = this.state.activeRlmSessions.get(childSessionKey);
    if (!parentSessionKey) return;

    // Clean up session mapping
    this.state.activeRlmSessions.delete(childSessionKey);

    const pending = this.state.pendingLargeContext.get(parentSessionKey);
    if (!pending) return;

    // Clean up pending context
    this.state.pendingLargeContext.delete(parentSessionKey);

    // Extract the subagent's answer
    const answer = typeof result === 'string' ? result : this.extractSubagentAnswer(result);
    if (!answer) {
      this.logger.warn(`[contexto] onSubagentEnded: no answer from subagent ${childSessionKey}`);
      return;
    }

    // Ingest the processed result into the mindmap for future recall
    const payload = buildPayload('rlm-summary', 'processed', parentSessionKey, {
      charCount: pending.content.length,
      tokenEstimate: pending.tokenEstimate,
    }, undefined, {
      userMessage: { role: 'user', content: `[Large context: ${pending.content.length} chars, ~${pending.tokenEstimate} tokens]` },
      assistantMessages: [{ role: 'assistant', content: answer }],
    });

    try {
      await this.backend.ingest(payload);
      this.logger.info(`[contexto] onSubagentEnded: ingested RLM summary (${answer.length} chars) for session ${parentSessionKey}`);
    } catch (err) {
      this.logger.warn(`[contexto] onSubagentEnded: failed to ingest RLM summary — ${err}`);
    }
  }

  // --- Helpers ---

  /** Extract text from a message with string or ContentBlock[] content. */
  protected extractMessageText(msg: any): string | undefined {
    if (!msg) return undefined;
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.content)) {
      const texts = msg.content
        .filter((b: any) => b.type === 'text' && typeof b.text === 'string')
        .map((b: any) => b.text);
      return texts.length > 0 ? texts.join('\n') : undefined;
    }
    return undefined;
  }

  /** Get pending large context for a session key. */
  getPendingContext(sessionKey: string): PendingContext | undefined {
    return this.state.pendingLargeContext.get(sessionKey);
  }

  /** Clear pending large context for a session key. */
  clearPendingContext(sessionKey: string): void {
    this.state.pendingLargeContext.delete(sessionKey);
  }

  /** Extract the last assistant text from subagent result. */
  private extractSubagentAnswer(result: any): string | undefined {
    if (!result) return undefined;
    // Handle array of messages
    const messages = Array.isArray(result) ? result : result?.messages;
    if (!Array.isArray(messages)) return typeof result === 'string' ? result : undefined;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const text = this.extractMessageText(msg);
      if (msg?.role === 'assistant' && text) return text;
    }
    return undefined;
  }

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
