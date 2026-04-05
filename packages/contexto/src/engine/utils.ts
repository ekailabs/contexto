import type { WebhookPayload } from '../types.js';
import { buildPayload } from '../helpers.js';

/** Estimate token count from raw messages using ~4 chars per token heuristic. */
function estimateMessageTokens(messages: any[]): number {
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

/** Estimate token count for episode payloads (WebhookPayload[]) in the buffer. */
export function estimatePayloadTokens(payloads: WebhookPayload[]): number {
  let total = 0;
  for (const p of payloads) {
    const data = p.data as Record<string, any> | undefined;
    if (!data) continue;
    const allMessages = [
      ...(data.userMessage ? [data.userMessage] : []),
      ...(Array.isArray(data.assistantMessages) ? data.assistantMessages : []),
      ...(Array.isArray(data.toolMessages) ? data.toolMessages : []),
    ];
    total += estimateMessageTokens(allMessages);
  }
  return total;
}

/** Build a single episode payload from all messages in a conversation turn. */
export function buildEpisodePayload(
  messages: any[],
  sessionId: string,
  sessionKey: string,
  runtimeContext?: Record<string, unknown>,
): WebhookPayload {
  const userMessage = messages.find((m: any) => m.role === 'user');
  const assistantMessages = messages.filter((m: any) => m.role === 'assistant');
  const toolMessages = messages.filter((m: any) => m.role === 'tool' || m.role === 'tool_result');
  const lastAssistant = assistantMessages[assistantMessages.length - 1];

  return buildPayload('episode', 'combined', sessionKey, {
    sessionId,
    model: runtimeContext?.model,
    provider: runtimeContext?.provider,
    stopReason: lastAssistant?.stopReason,
  }, undefined, {
    userMessage,
    assistantMessages,
    toolMessages,
  });
}

/**
 * Select the oldest episode payloads from the buffer until `tokensToFree` is satisfied.
 * Returns { toEvict, kept } — the split point in the buffer.
 */
export function selectMessagesToEvict(
  bufferedMessages: WebhookPayload[],
  tokensToFree: number,
): { toEvict: WebhookPayload[]; kept: WebhookPayload[] } {
  let freedTokens = 0;
  let evictCount = 0;
  for (let i = 0; i < bufferedMessages.length && freedTokens < tokensToFree; i++) {
    freedTokens += estimatePayloadTokens([bufferedMessages[i]]);
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
