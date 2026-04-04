import type { AfterTurnParams, CompactParams, CompactResult } from './types.js';
import { AbstractContextEngine } from './base.js';
import { buildMessagePayloads } from './utils.js';

/**
 * Default engine — buffers messages and ingests them to the backend on
 * compact() or dispose(). Does NOT own compaction; the runtime handles
 * context window eviction.
 */
export class DefaultContextEngine extends AbstractContextEngine {
  readonly ownsCompaction = false;

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

    const sessionKey = params.sessionKey || params.sessionId;
    const payloads = buildMessagePayloads(this.state.bufferedMessages, params.sessionId, sessionKey);

    this.logger.info(`[contexto] compact: ingesting ${this.state.bufferedMessages.length} buffered messages`);
    await this.backend.ingest(payloads);
    this.state.bufferedMessages = [];

    return { ok: true, compacted: false, reason: 'delegated to runtime' };
  }

  async dispose(): Promise<void> {
    if (!this.config.apiKey || this.state.bufferedMessages.length === 0) return;

    const payloads = buildMessagePayloads(this.state.bufferedMessages, this.state.lastSessionId, this.state.lastSessionKey);
    this.logger.info(`[contexto] dispose: ingesting ${this.state.bufferedMessages.length} remaining buffered messages`);
    await this.backend.ingest(payloads);
    this.state.bufferedMessages = [];
  }
}
