import type { CompactResult } from 'openclaw/plugin-sdk';
import type { AfterTurnParams, CompactParams } from './types.js';
import { AbstractContextEngine } from './base.js';
import { buildEpisodePayload } from './utils.js';

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

    const sessionKey = params.sessionKey || params.sessionId;
    const episode = buildEpisodePayload(newMessages, params.sessionId, sessionKey, params.runtimeContext);
    this.state.bufferedMessages.push(episode);
    this.logger.info(`[contexto] afterTurn: buffered 1 episode (${newMessages.length} messages, total episodes: ${this.state.bufferedMessages.length})`);
  }

  async compact(params: CompactParams): Promise<CompactResult> {
    if (params.tokenBudget != null) this.state.cachedTokenBudget = params.tokenBudget;

    if (!this.config.apiKey || this.state.bufferedMessages.length === 0) {
      return { ok: true, compacted: false, reason: 'nothing to compact' };
    }

    this.logger.info(`[contexto] compact: ingesting ${this.state.bufferedMessages.length} buffered episodes`);
    await this.backend.ingest(this.state.bufferedMessages);
    this.state.bufferedMessages = [];
    this.state.injectedItemIds.clear();

    return { ok: true, compacted: false, reason: 'delegated to runtime' };
  }

  async dispose(): Promise<void> {
    if (!this.config.apiKey || this.state.bufferedMessages.length === 0) return;

    this.logger.info(`[contexto] dispose: ingesting ${this.state.bufferedMessages.length} remaining buffered episodes`);
    await this.backend.ingest(this.state.bufferedMessages);
    this.state.bufferedMessages = [];
    this.state.injectedItemIds.clear();
  }
}
