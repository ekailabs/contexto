import type { ContextoBackend, Logger, WebhookPayload } from './types.js';

/** Construct a webhook payload with a timestamp. */
function buildPayload(
  type: string,
  action: string,
  sessionKey: string,
  context: Record<string, unknown>,
  agent?: Record<string, unknown>,
  data?: Record<string, unknown>,
): WebhookPayload {
  return {
    event: { type, action },
    sessionKey,
    timestamp: new Date().toISOString(),
    context,
    agent,
    data,
  };
}

/** Wire up message_received and llm_output events to ingest into the backend. */
export function registerHooks(api: any, backend: ContextoBackend, logger: Logger): void {
  api.on('message_received', async (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey || 'unknown';
    const payload = buildPayload(
      'message',
      'received',
      sessionKey,
      {
        from: event?.from,
        timestamp: event?.timestamp,
        provider: event?.metadata?.provider,
        surface: event?.metadata?.surface,
        threadId: event?.metadata?.threadId,
        channelName: event?.metadata?.channelName,
        senderId: event?.metadata?.senderId,
        senderName: event?.metadata?.senderName,
        senderUsername: event?.metadata?.senderUsername,
        messageId: event?.metadata?.messageId,
      },
      undefined,
      {
        content: event?.content,
      },
    );

    backend.ingest(payload);
  });

  api.on('llm_output', async (event: any, ctx: any) => {
    const sessionKey = ctx?.sessionKey || 'unknown';
    const payload = buildPayload(
      'llm',
      'output',
      sessionKey,
      {
        model: event?.model,
        usage: {
          prompt_tokens: event?.usage?.promptTokens,
          completion_tokens: event?.usage?.completionTokens,
          total_tokens: event?.usage?.totalTokens,
        },
      },
      undefined,
      {
        content: event?.assistantText,
      },
    );

    backend.ingest(payload);
  });
}
