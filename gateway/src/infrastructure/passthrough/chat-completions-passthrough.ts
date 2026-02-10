import { Response as ExpressResponse } from 'express';
import { AuthenticationError, PaymentError, ProviderError } from '../../shared/errors/index.js';
import { logger } from '../utils/logger.js';
import { CONTENT_TYPES, HTTP_STATUS } from '../../domain/types/provider.js';
import { injectMemoryContext, persistMemory } from '../memory/memory-helper.js';

export type ChatUsageFormat = 'openai_chat';

export interface ChatCompletionsAuthConfig {
  envVar: string;
  header: string;
  scheme?: string;
  template?: string;
}

export interface ChatCompletionsUsageConfig {
  format: ChatUsageFormat;
}

export interface ChatCompletionsPayloadDefaults {
  [key: string]: any;
}

export interface ChatCompletionsPassthroughConfig {
  provider: string;
  baseUrl: string;
  auth?: ChatCompletionsAuthConfig;
  staticHeaders?: Record<string, string>;
  supportedClientFormats: string[];
  payloadDefaults?: ChatCompletionsPayloadDefaults;
  usage?: ChatCompletionsUsageConfig;
  forceStreamOption?: boolean;
}

interface OpenAIChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
  const output = { ...target } as Record<string, any>;
  Object.entries(source).forEach(([key, value]) => {
    if (isObject(value) && isObject(output[key])) {
      output[key] = mergeDeep(output[key] as Record<string, any>, value as Record<string, any>);
    } else {
      output[key] = value;
    }
  });
  return output as T;
}

export class ChatCompletionsPassthrough {
  private eventBuffer = '';
  private x402FetchFunction: typeof fetch | null = null;
  private x402Initialized = false;
  private lastX402PaymentAmount: string | undefined = undefined;
  private assistantResponseBuffer = '';

  constructor(private readonly config: ChatCompletionsPassthroughConfig) {
    // Initialize x402 payment wrapper once if needed
    this.initializeX402Support();
  }

  private async initializeX402Support(): Promise<void> {
    // Only initialize for OpenRouter with x402 URL and PRIVATE_KEY
    const { getConfig } = await import('../config/app-config.js');
    const config = getConfig();
    const shouldUseX402 = 
      this.config.provider === 'openrouter' && 
      config.x402.enabled && 
      this.config.baseUrl.includes('x402');

    if (!shouldUseX402) {
      this.x402Initialized = true;
      return;
    }

    try {
      const { getX402Account, createX402Fetch, logPaymentReady } = await import('../payments/x402/index.js');
      const account = getX402Account();
      
      if (account) {
        this.x402FetchFunction = createX402Fetch(account);
        logPaymentReady(account, {
          provider: this.config.provider,
          baseUrl: this.config.baseUrl,
        });
        logger.info('x402 payment support initialized', {
          provider: this.config.provider,
          walletAddress: account.address,
          module: 'chat-completions-passthrough',
        });
      } else {
        logger.error('x402 wallet initialization failed - getX402Account returned null', {
          provider: this.config.provider,
          module: 'chat-completions-passthrough',
        });
      }
    } catch (error) {
      logger.error('Failed to initialize x402 payments', error, {
        provider: this.config.provider,
        errorMessage: error instanceof Error ? error.message : String(error),
        module: 'chat-completions-passthrough',
      });
    } finally {
      this.x402Initialized = true;
    }
  }

  private resolvedKey: string | undefined;

  private get apiKey(): string | undefined {
    if (this.resolvedKey) return this.resolvedKey;
    const auth = this.config.auth;
    if (!auth) return undefined;
    const token = process.env[auth.envVar];
    if (!token) {
      throw new AuthenticationError(`${this.config.provider} API key not configured`, { provider: this.config.provider });
    }
    return token;
  }

  private buildAuthHeader(): string | undefined {
    const auth = this.config.auth;
    const token = this.resolvedKey || this.apiKey;
    if (!token) return undefined;

    if (this.resolvedKey) return `Bearer ${this.resolvedKey}`;

    if (!auth) return undefined;
    const { scheme, template } = auth;

    if (template) {
      return template.replace('{{token}}', token);
    }

    if (scheme) {
      return `${scheme} ${token}`.trim();
    }

    return token;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.staticHeaders) {
      Object.assign(headers, this.config.staticHeaders);
    }

    try {
      const { resolveKeyForProvider } = await import('../auth/key-manager.js');
      this.resolvedKey = await resolveKeyForProvider(this.config.provider);
    } catch {
      this.resolvedKey = undefined;
    }

    const authHeader = this.buildAuthHeader();
    if (authHeader) {
      const headerName = this.config.auth?.header ?? 'Authorization';
      headers[headerName] = authHeader;
    }

    return headers;
  }

  private buildPayload(body: any, stream: boolean): any {
    let payload = isObject(body) ? { ...body } : body;

    if (isObject(payload)) {
      if (this.config.forceStreamOption !== false) {
        payload.stream = stream;
      }

      if (this.config.payloadDefaults) {
        payload = mergeDeep(payload, this.config.payloadDefaults);
      }
    }

    return payload;
  }

  private async makeRequest(body: any, stream: boolean): Promise<globalThis.Response> {
    // Wait for x402 initialization to complete
    while (!this.x402Initialized) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Use x402 fetch if available, otherwise standard fetch
    const fetchFunction = this.x402FetchFunction || fetch;
    const isX402Enabled = this.x402FetchFunction !== null;

    // Log which authentication method is being used for this request
    if (isX402Enabled) {
      logger.info('Making request with x402 payment (PRIVATE_KEY)', {
        provider: this.config.provider,
        model: body?.model,
        baseUrl: this.config.baseUrl,
        stream,
        module: 'chat-completions-passthrough',
      });
    } else {
      logger.info('Making request with API key authentication', {
        provider: this.config.provider,
        model: body?.model,
        baseUrl: this.config.baseUrl,
        apiKeyEnvVar: this.config.auth?.envVar,
        stream,
        module: 'chat-completions-passthrough',
      });
    }

    let response: globalThis.Response;
    
    try {
      response = await fetchFunction(this.config.baseUrl, {
        method: 'POST',
        headers: await this.buildHeaders(),
        body: JSON.stringify(this.buildPayload(body, stream)),
      });
    } catch (error) {
      // Catch x402 payment errors (insufficient balance, payment failures, etc.)
      if (isX402Enabled) {
        logger.error('x402 payment request failed', error, {
          provider: this.config.provider,
          baseUrl: this.config.baseUrl,
          errorMessage: error instanceof Error ? error.message : String(error),
          module: 'chat-completions-passthrough',
        });
      }
      throw error;
    }

    // Store fixed x402 cost for chat completions ($0.02 per request)
    // TODO: Replace with dynamically calculated amounts from x402 payment response
    if (isX402Enabled) {
      this.lastX402PaymentAmount = '0.02';
      
      const { logPaymentInfo, extractPaymentInfo } = await import('../payments/x402/index.js');
      const paymentInfo = extractPaymentInfo(response);
      if (paymentInfo) {
        logPaymentInfo(paymentInfo, {
          provider: this.config.provider,
          model: body?.model,
        });
      }
    }

    // Handle failed responses
    if (!response.ok) {
      const errorText = await response.text();
      
      // Special handling for 402 with x402 enabled - payment failed
      if (response.status === 402 && isX402Enabled) {
        logger.error('x402 payment failed', {
          provider: this.config.provider,
          error: errorText,
          module: 'chat-completions-passthrough',
        });
        throw new PaymentError(
          errorText || 'Insufficient balance or payment error',
          { provider: this.config.provider, statusCode: response.status }
        );
      }
      
      // Standard error handling for other failures
      throw new ProviderError(
        this.config.provider,
        errorText || `HTTP ${response.status}`,
        response.status,
        { endpoint: this.config.baseUrl }
      );
    }

    return response;
  }


  private recordOpenAIUsage(usage: OpenAIChatUsage, model: string, clientIp?: string): void {
    const totalInputTokens = usage.prompt_tokens ?? 0;
    const cachedPromptTokens = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const nonCachedPromptTokens = totalInputTokens - cachedPromptTokens;
    const completionTokens = usage.completion_tokens ?? 0;

    logger.debug('Tracking chat completions usage', {
      provider: this.config.provider,
      model,
      totalInputTokens,
      nonCachedPromptTokens,
      cachedPromptTokens,
      completionTokens,
      totalTokens: usage.total_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
      x402PaymentAmount: this.lastX402PaymentAmount,
      willUseX402Pricing: !!this.lastX402PaymentAmount,
      module: 'chat-completions-passthrough',
    });

    import('../utils/usage-tracker.js')
      .then(({ usageTracker }) => {
        usageTracker.trackUsage(
          model,
          this.config.provider,
          Math.max(nonCachedPromptTokens, 0),
          completionTokens,
          Math.max(cachedPromptTokens, 0),
          0,
          clientIp,
          this.lastX402PaymentAmount, // Pass x402 payment amount if available
        );
        // Clear payment amount after tracking
        this.lastX402PaymentAmount = undefined;
      })
      .catch(error => {
        logger.error('Usage tracking failed', error, {
          provider: this.config.provider,
          operation: 'passthrough',
          module: 'chat-completions-passthrough',
        });
      });
  }

  private recordUsage(usage: unknown, model: string, clientIp?: string): void {
    if (!usage || !this.config.usage?.format) return;

    switch (this.config.usage.format) {
      case 'openai_chat':
        this.recordOpenAIUsage(usage as OpenAIChatUsage, model, clientIp);
        break;
      default:
        logger.warn('Unsupported usage format for chat completions passthrough', {
          provider: this.config.provider,
          format: this.config.usage.format,
          module: 'chat-completions-passthrough',
        });
    }
  }

  private processStreamingChunk(chunk: string, model: string, clientIp?: string): void {
    try {
      this.eventBuffer += chunk;

      const events = this.eventBuffer.split(/\r?\n\r?\n/);
      this.eventBuffer = events.pop() ?? '';

      for (const event of events) {
        const dataLine = event.split(/\r?\n/).find(line => line.startsWith('data:'));
        if (!dataLine) continue;

        const payload = dataLine.replace('data:', '').trim();
        if (!payload || payload === '[DONE]') {
          continue;
        }

        try {
          const parsed = JSON.parse(payload);
          
          // Extract assistant response content
          if (parsed?.choices?.[0]?.delta?.content) {
            this.assistantResponseBuffer += parsed.choices[0].delta.content;
          }
          
          if (parsed?.usage) {
            this.recordUsage(parsed.usage, model, clientIp);
            // reset buffer after successful usage capture to avoid duplicate processing
            this.eventBuffer = '';
          }
        } catch (parseError) {
          logger.debug('Skipping incomplete chat streaming chunk', {
            provider: this.config.provider,
            error: parseError instanceof Error ? parseError.message : String(parseError),
            module: 'chat-completions-passthrough',
          });
        }
      }

      if (this.eventBuffer.includes('[DONE]')) {
        this.eventBuffer = '';
      }
    } catch (error) {
      logger.error('Chat streaming usage tracking failed', error, {
        provider: this.config.provider,
        operation: 'passthrough',
        module: 'chat-completions-passthrough',
      });
    }
  }

  async handleDirectRequest(request: any, res: ExpressResponse, clientIp?: string): Promise<void> {
    this.eventBuffer = '';
    this.assistantResponseBuffer = '';
    this.lastX402PaymentAmount = undefined; // Reset payment amount for new request

    // Retrieve and inject memory context
    injectMemoryContext(request, {
      provider: this.config.provider,
      defaultUserId: 'default',
      extractCurrentUserInputs: req => extractOpenAIUserMessages(req),
      applyMemoryContext: (req, context) => {
        if (!req.messages) {
          req.messages = [];
        }
        req.messages.unshift({
          role: 'system',
          content: context,
        });
      }
    });

    if (request?.stream) {
      const response = await this.makeRequest(request, true);

      if (!response.ok) {
        const bodyText = await response.text();
        const contentType = response.headers.get('content-type') ?? CONTENT_TYPES.JSON;
        res.status(response.status).set('Content-Type', contentType).send(bodyText);
        return;
      }

      res.writeHead(HTTP_STATUS.OK, {
        'Content-Type': CONTENT_TYPES.EVENT_STREAM,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const reader = response.body?.getReader();
      if (!reader) {
        throw new ProviderError(this.config.provider, 'No stream body received', 500);
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = new TextDecoder().decode(value);
        setImmediate(() => this.processStreamingChunk(text, request?.model, clientIp));
        res.write(value);
      }

      res.end();
      
      // Persist memory after streaming completes
      persistMemory(request, this.assistantResponseBuffer, {
        provider: this.config.provider,
        defaultUserId: 'default',
        extractUserContent: req => extractOpenAILastUserContent(req),
        metadataBuilder: req => ({
          model: req.model,
          provider: this.config.provider,
        }),
      });
      return;
    }

    const response = await this.makeRequest(request, false);

    if (!response.ok) {
      const bodyText = await response.text();
      const contentType = response.headers.get('content-type') ?? CONTENT_TYPES.JSON;
      res.status(response.status).set('Content-Type', contentType).send(bodyText);
      return;
    }

    const json = await response.json();

    if (json?.usage) {
      this.recordUsage(json.usage, request?.model, clientIp);
    }

    // Extract assistant response from non-streaming response
    const assistantResponse = json?.choices?.[0]?.message?.content || '';
    persistMemory(request, assistantResponse, {
      provider: this.config.provider,
      defaultUserId: 'default',
      extractUserContent: req => extractOpenAILastUserContent(req),
      metadataBuilder: req => ({
        model: req.model,
        provider: this.config.provider,
      }),
    });

    res.status(HTTP_STATUS.OK).json(json);
  }
  
}

function extractOpenAIUserMessages(request: any): string[] {
  const currentMessages = request.messages || [];
  return currentMessages
    .filter((msg: any) => msg.role === 'user')
    .map((msg: any) => {
      const content = typeof msg.content === 'string'
        ? msg.content
        : JSON.stringify(msg.content);
      return content;
    });
}

function extractOpenAILastUserContent(request: any): string | null {
  const messages = request.messages || [];
  const userMessages = messages.filter((msg: any) => msg.role === 'user');
  if (!userMessages.length) {
    return null;
  }
  const lastUserMessage = userMessages[userMessages.length - 1];
  return typeof lastUserMessage.content === 'string'
    ? lastUserMessage.content
    : JSON.stringify(lastUserMessage.content);
}
