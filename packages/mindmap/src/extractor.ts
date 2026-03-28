import type { ConversationItem } from './types.js';

interface WebhookPayload {
  event: { type: string; action: string };
  sessionKey?: string;
  timestamp?: string;
  context?: Record<string, any>;
  data?: Record<string, any>;
}

export function extractFromWebhook(payload: WebhookPayload): Omit<ConversationItem, 'embedding'> | null {
  const { event, timestamp, context, data } = payload;

  if (event.type === 'message' && event.action === 'received') {
    const content = data?.content;
    if (!content || typeof content !== 'string') return null;

    return {
      id: context?.messageId ?? crypto.randomUUID(),
      role: 'user',
      content,
      timestamp,
      metadata: {
        provider: context?.provider,
        surface: context?.surface,
        senderId: context?.senderId,
        senderName: context?.senderName,
      },
    };
  }

  if (event.type === 'llm' && event.action === 'output') {
    const contentBlocks = data?.content;
    if (!Array.isArray(contentBlocks)) return null;

    const text = contentBlocks
      .filter((block: any) => block.type === 'text' && block.text)
      .map((block: any) => block.text)
      .join('\n');

    if (!text) return null;

    return {
      id: context?.responseId ?? crypto.randomUUID(),
      role: 'assistant',
      content: text,
      timestamp,
      metadata: {
        model: context?.model,
        provider: context?.provider,
        usage: context?.usage,
      },
    };
  }

  return null;
}
