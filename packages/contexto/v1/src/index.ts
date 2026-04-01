const WEBHOOK_URL_BASE = 'https://api.getcontexto.com';
const DEFAULT_MAX_CONTEXT_CHARS = 2000;

interface WebhookConfig {
  apiKey: string;
  contextEnabled: boolean;
  maxContextChars?: number;
}

interface WebhookPayload {
  event: {
    type: string;
    action: string;
  };
  sessionKey: string;
  timestamp: string;
  context: Record<string, unknown>;
  agent?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

async function sendWebhook(config: WebhookConfig, payload: WebhookPayload, logger: any): Promise<void> {
  try {
    const response = await fetch(`${WEBHOOK_URL_BASE}/v1/webhooks/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      logger.warn(`[contexto] webhook HTTP ${response.status}: ${response.statusText} — body: ${body}`);
    } else {
      logger.info(`[contexto] webhook OK ${response.status} for ${payload.event.type}:${payload.event.action}`);
    }
  } catch (err) {
    logger.warn(`[contexto] webhook failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildPayload(
  type: string,
  action: string,
  sessionKey: string,
  context: Record<string, unknown>,
  agent?: Record<string, unknown>,
  data?: Record<string, unknown>
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

function lastUserMessage(messages: any[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text.trim()) return text;
    }
  }
}

async function fetchContext(
  config: WebhookConfig,
  query: string,
  sessionKey: string,
  logger: any,
  maxChars: number = DEFAULT_MAX_CONTEXT_CHARS,
): Promise<string | undefined> {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${config.apiKey}`,
  };

  let result: any = null;
  try {
    const response = await fetch(`${WEBHOOK_URL_BASE}/v1/mindmap/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, sessionKey, maxResults: 5 }),
    });
    if (response.ok) {
      result = await response.json();
    } else {
      logger.warn(`[contexto] /v1/mindmap/query HTTP ${response.status}`);
    }
  } catch (err) {
    logger.warn(`[contexto] /v1/mindmap/query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  let context = '';

  // Format query results (QueryResult shape: { items: [{ content, role }], path: string[] })
  if (result?.items?.length) {
    const block = result.items
      .slice(0, 5)
      .map((item: any) => `- ${item.content}`)
      .join('\n');
    context += `## Relevant Context\n${block}\n\n`;
  }

  if (!context.trim()) return undefined;

  if (context.length > maxChars) {
    context = context.slice(0, maxChars) + '…';
  }

  return context.trim();
}

export default {
  id: 'contexto',
  name: 'Contexto',
  description: 'Context engine for OpenClaw with mindmap',

  configSchema: {
    type: 'object',
    properties: {
      apiKey: { type: 'string' },
      contextEnabled: { type: 'boolean', default: false },
      maxContextChars: { type: 'number' },
    },
  },

  register(api: any) {
    const config: WebhookConfig = {
      apiKey: api.pluginConfig?.apiKey,
      contextEnabled: api.pluginConfig?.contextEnabled ?? false,
      maxContextChars: api.pluginConfig?.maxContextChars,
    };

    const logger = api.logger;

    if (!config.apiKey) {
      logger.warn('[contexto] Missing apiKey — ingestion and retrieval will be disabled');
    }

    // --- Ingestion via hooks (preserves raw event data including images, tool use, etc.) ---

    api.on('message_received', async (event: any, ctx: any) => {
      if (!config.apiKey) return;

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
        }
      );

      sendWebhook(config, payload, logger);
    });

    // --- LLM Raw Output (as soon as the model finishes generating) ---
    api.on('llm_output', async (event: any, ctx: any) => {
      if (!config.apiKey) return;

      const sessionKey = ctx?.sessionKey || 'unknown';
      const payload = buildPayload(
        'llm',           // Type: LLM generation
        'output',        // Action: model output received
        sessionKey,
        {
          model: event?.model,            // The model used (e.g., 'gpt-4o')
          usage: {
            prompt_tokens: event?.usage?.promptTokens,
            completion_tokens: event?.usage?.completionTokens,
            total_tokens: event?.usage?.totalTokens
          }
        },
        undefined,
        {
          content: event?.assistantText,  // The actual text generated by the AI
        }
      );
      sendWebhook(config, payload, logger);
    });

    // --- Retrieval via context engine ---
    api.registerContextEngine('contexto', () => ({
      info: {
        id: 'contexto',
        name: 'Contexto',
        ownsCompaction: false,
      },

      async ingest() {
        // No-op — ingestion handled by hooks above to preserve raw event data
        logger.info('[contexto] ingest() called');
        return { ingested: true };
      },

      async assemble({ sessionId, messages, tokenBudget }: any) {
        logger.info(`[contexto] assemble() called — ${messages?.length} messages, tokenBudget: ${tokenBudget}`);
        if (!config.apiKey || !config.contextEnabled) {
          return { messages, estimatedTokens: 0 };
        }

        const query = lastUserMessage(messages);
        if (!query) {
          return { messages, estimatedTokens: 0 };
        }

        const maxChars = tokenBudget
          ? Math.floor(tokenBudget * 0.1 * 4)
          : (config.maxContextChars ?? DEFAULT_MAX_CONTEXT_CHARS);
        const context = await fetchContext(config, query, sessionId, logger, maxChars);
        if (context) {
          logger.info(`[contexto] Injecting ${context.length} chars of context`);
        }

        logger.info('[contexto] Context assembled successfully')
        return {
          messages,
          estimatedTokens: 0,
          ...(context ? { systemPromptAddition: context } : {}),
        };
      },

      async compact() {
        return { ok: true, compacted: false };
      },
    }));

    logger.info(`[contexto] Plugin registered (contextEnabled: ${config.contextEnabled})`);
  },
};