import type { WebhookPayload } from '../types.js';
import { buildPayload } from '../hooks.js';

/** Estimate token count from messages using ~4 chars per token heuristic. */
export function estimateTokens(messages: any[]): number {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') {
      chars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          chars += block.text.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

/** Build one webhook payload per message for batch ingestion. */
export function buildMessagePayloads(messages: any[], sessionId: string, sessionKey: string): WebhookPayload[] {
  return messages.map((m: any) =>
    buildPayload('episode', 'combined', sessionKey, {
      sessionId,
      role: m.role,
    }, undefined, {
      content: m.content,
    }),
  );
}

/**
 * Select the oldest messages from the buffer until `tokensToFree` is satisfied.
 * Returns { toEvict, kept } — the split point in the buffer.
 */
export function selectMessagesToEvict(
  bufferedMessages: any[],
  tokensToFree: number,
): { toEvict: any[]; kept: any[] } {
  let freedTokens = 0;
  let evictCount = 0;
  for (let i = 0; i < bufferedMessages.length && freedTokens < tokensToFree; i++) {
    freedTokens += estimateTokens([bufferedMessages[i]]);
    evictCount++;
  }
  return {
    toEvict: bufferedMessages.slice(0, evictCount),
    kept: bufferedMessages.slice(evictCount),
  };
}

/** Extract the firstKeptEntryId from the first message in an array (if available). */
export function getFirstKeptEntryId(messages: any[]): string | undefined {
  const first = messages.length > 0 ? messages[0] : null;
  return first?.id ?? first?.entryId ?? undefined;
}
