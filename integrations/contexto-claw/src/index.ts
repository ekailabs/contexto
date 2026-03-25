const WEBHOOK_URL_BASE = 'https://your-api.com';

interface WebhookConfig {
  apiKey: string;
  contextEnabled: boolean;
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
    const response = await fetch(`${WEBHOOK_URL_BASE}/v1/webhook/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      logger.warn(`[webhook] HTTP ${response.status}: ${response.statusText}`);
    }
  } catch (err) {
    logger.warn(`[webhook] Failed to send: ${err instanceof Error ? err.message : String(err)}`);
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

const webhookPlugin = {
  id: '@ekai/contexto-claw',
  name: 'Contexto Claw',
  description: 'Sends OpenClaw context engine events to a webhook API',

  configSchema: {
    type: 'object',
    properties: {
      apiKey: { type: 'string' },
      contextEnabled: { type: 'boolean', default: false },
    },
  },

  register(api: any) {
    const config: WebhookConfig = {
      apiKey: api.pluginConfig?.apiKey,
      contextEnabled: api.pluginConfig?.contextEnabled ?? false,
    };

    const logger = api.logger;

    if (!config.apiKey) {
      logger.warn('[webhook] Missing apiKey - events will not be sent');
    }

    logger.info(`[webhook] Plugin registered, baseUrl: ${WEBHOOK_URL_BASE}`);

    api.on('before_prompt_build', async (event: any, ctx: any) => {
      if (!config.contextEnabled) return;

      const sessionKey = event?.sessionKey || ctx?.sessionKey || 'unknown';
      const messages: any[] = event?.messages || [];

      const lastUserMessage = messages
        .slice()
        .reverse()
        .find((m: any) => m.role === 'user');

      try {
        const response = await fetch(`${WEBHOOK_URL_BASE}/v1/context`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.apiKey ? { 'Authorization': `Bearer ${config.apiKey}` } : {}),
          },
          body: JSON.stringify({
            sessionKey,
            messages: messages.map((m: any) => ({
              role: m.role,
              content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
            })),
            lastUserMessage: lastUserMessage?.content,
          }),
        });

        if (!response.ok) {
          logger.warn(`[context] API returned ${response.status}: ${response.statusText}`);
          return;
        }

        const data = await response.json() as { context?: string };
        
        if (data?.context) {
          return { prependContext: data.context };
        }
      } catch (err) {
        logger.warn(`[context] Failed to fetch: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    api.on('before_agent_start', async (event: any, ctx: any) => {
      if (!config.apiKey) return;

      const sessionKey = event?.sessionKey || ctx?.sessionKey || 'unknown';
      const payload = buildPayload(
        'agent',
        'before_start',
        sessionKey,
        {
          model: event?.model,
          prompt: event?.prompt?.slice(0, 500),
        },
        { agentId: ctx?.agentId || event?.agentId || 'main' }
      );

      sendWebhook(config, payload, logger);
    });

    api.on('agent_end', async (event: any, ctx: any) => {
      if (!config.apiKey) return;

      const sessionKey = event?.sessionKey || ctx?.sessionKey || 'unknown';
      const messages: any[] = event?.messages || [];

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let costUsd: number | undefined;
      let model = 'unknown';

      for (const msg of messages) {
        if (msg?.role === 'assistant' && msg?.usage) {
          const u = msg.usage;
          totalInputTokens += u.input || u.inputTokens || u.input_tokens || 0;
          totalOutputTokens += u.output || u.outputTokens || u.output_tokens || 0;
          cacheReadTokens += u.cacheRead || 0;
          cacheWriteTokens += u.cacheWrite || 0;
        }
        if (msg?.role === 'assistant' && msg?.model) {
          model = msg.model;
        }
      }

      const payload = buildPayload(
        'agent',
        'end',
        sessionKey,
        {
          success: event?.success,
          error: event?.error,
          durationMs: event?.durationMs,
          messageCount: messages.length,
        },
        {
          agentId: ctx?.agentId || event?.agentId || 'main',
          model,
        },
        {
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens: totalInputTokens + totalOutputTokens + cacheReadTokens + cacheWriteTokens,
          },
          costUsd,
          messages: messages.map((m: any) => ({
            role: m.role,
            content: m.content,
          })),
        }
      );

      sendWebhook(config, payload, logger);
    });

    api.on('session:compact:before', async (event: any, ctx: any) => {
      if (!config.apiKey) return;

      const sessionKey = event?.sessionKey || ctx?.sessionKey || 'unknown';
      const payload = buildPayload(
        'session',
        'compact:before',
        sessionKey,
        {
          messageCount: event?.messageCount || ctx?.messageCount,
          tokenCount: event?.tokenCount,
        },
        { agentId: ctx?.agentId || 'main' }
      );

      sendWebhook(config, payload, logger);
    });

    api.on('session:compact:after', async (event: any, ctx: any) => {
      if (!config.apiKey) return;

      const sessionKey = event?.sessionKey || ctx?.sessionKey || 'unknown';
      const payload = buildPayload(
        'session',
        'compact:after',
        sessionKey,
        {
          summary: event?.summary,
          originalMessageCount: event?.originalMessageCount,
          compactedMessageCount: event?.compactedMessageCount,
        },
        { agentId: ctx?.agentId || 'main' }
      );

      sendWebhook(config, payload, logger);
    });

    api.registerHook(
      ['command:new', 'command:reset', 'command:stop'],
      async (event: any) => {
        if (!config.apiKey) return;

        const sessionKey = event?.sessionKey || 'unknown';
        const action = event?.action || 'unknown';
        const payload = buildPayload(
          'command',
          action,
          sessionKey,
          {
            commandSource: event?.context?.commandSource,
            senderId: event?.context?.senderId,
            workspaceDir: event?.context?.workspaceDir,
          }
        );

        sendWebhook(config, payload, logger);
      },
      {
        name: 'webhook-commands',
        description: 'Sends command events to webhook',
      }
    );

    api.registerHook(
      'agent:bootstrap',
      async (event: any) => {
        if (!config.apiKey) return;

        const sessionKey = event?.sessionKey || 'unknown';
        const payload = buildPayload(
          'agent',
          'bootstrap',
          sessionKey,
          {
            bootstrapFilesCount: event?.context?.bootstrapFiles?.length || 0,
          },
          { agentId: event?.context?.agentId || 'main' }
        );

        sendWebhook(config, payload, logger);
      },
      {
        name: 'webhook-agent-bootstrap',
        description: 'Sends agent bootstrap to webhook',
      }
    );

    logger.info('[webhook] All hooks registered');
  },
};

export default webhookPlugin;