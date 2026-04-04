import type { SlidingWindowConfig, ContextoBackend, Logger } from '../types.js';
import type { CompactionState, CompactParams, CompactResult, AfterTurnParams } from './types.js';
import { AbstractContextEngine } from './base.js';
import { estimateTokens, buildMessagePayloads, selectMessagesToEvict, getFirstKeptEntryId } from './utils.js';

/**
 * Sliding-window engine — owns compaction and controls which messages
 * get evicted from the context window.
 *
 * At compactThreshold (default 50%) of the token budget, compact() ingests
 * the oldest buffered messages to the backend and evicts them from the
 * context window in a single step.
 */
export class SlidingWindowEngine extends AbstractContextEngine {
  protected declare config: SlidingWindowConfig;
  readonly ownsCompaction = true;

  constructor(state: CompactionState, config: SlidingWindowConfig, backend: ContextoBackend, logger: Logger) {
    super(state, config, backend, logger);
  }

  protected handleAfterTurn(params: AfterTurnParams): void {
    const newMessages = params.messages.slice(params.prePromptMessageCount);
    if (newMessages.length === 0) return;

    this.state.lastSessionId = params.sessionId;
    this.state.lastSessionKey = params.sessionKey || params.sessionId;

    this.state.bufferedMessages.push(...newMessages);
    this.logger.info(`[contexto] afterTurn: buffered ${newMessages.length} messages (total: ${this.state.bufferedMessages.length})`);
  }

  async compact(params: CompactParams): Promise<CompactResult> {
    if (params.tokenBudget != null) this.state.cachedTokenBudget = params.tokenBudget;

    if (!this.config.apiKey || this.state.bufferedMessages.length === 0) {
      return { ok: true, compacted: false, reason: 'nothing to compact' };
    }

    const tokenBudget = params.tokenBudget ?? this.state.cachedTokenBudget;
    const compactAt = tokenBudget
      ? Math.floor((this.config.compactThreshold ?? 0.50) * tokenBudget)
      : 0;
    const currentTokens = params.currentTokenCount ?? 0;

    if (currentTokens <= compactAt && !params.force) {
      return { ok: true, compacted: false, reason: 'below compact threshold' };
    }

    // Select oldest buffered messages to free enough tokens
    const tokensToFree = currentTokens - compactAt;
    const { toEvict, kept } = selectMessagesToEvict(this.state.bufferedMessages, tokensToFree);

    if (toEvict.length === 0) {
      return { ok: true, compacted: false, reason: 'no messages to evict' };
    }

    const firstKeptEntryId = getFirstKeptEntryId(kept);

    // Ingest evicted messages to backend
    const sessionKey = this.state.lastSessionKey || params.sessionKey || params.sessionId;
    const payloads = buildMessagePayloads(toEvict, params.sessionId, sessionKey);

    this.logger.info(
      `[contexto] compact: ingesting and evicting ${toEvict.length} messages ` +
      `(current: ${currentTokens}, threshold: ${compactAt}, firstKeptEntryId: ${firstKeptEntryId})`,
    );

    await this.backend.ingest(payloads);
    this.state.bufferedMessages = kept;

    return {
      ok: true,
      compacted: true,
      reason: 'ingested and evicted messages',
      result: {
        firstKeptEntryId,
        tokensBefore: currentTokens,
        tokensAfter: currentTokens - estimateTokens(toEvict),
      },
    };
  }

  async dispose(): Promise<void> {
    if (!this.config.apiKey || this.state.bufferedMessages.length === 0) return;

    const payloads = buildMessagePayloads(this.state.bufferedMessages, this.state.lastSessionId, this.state.lastSessionKey);
    this.logger.info(`[contexto] dispose: ingesting ${this.state.bufferedMessages.length} remaining buffered messages`);
    await this.backend.ingest(payloads);
    this.state.bufferedMessages = [];
  }
}
