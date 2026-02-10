import { Response as ExpressResponse } from 'express';
import { logger } from '../utils/logger.js';
import { AuthenticationError, PaymentError, ProviderError } from '../../shared/errors/index.js';
import { CONTENT_TYPES } from '../../domain/types/provider.js';
import { ModelUtils } from '../utils/model-utils.js';
import { injectMemoryContext, persistMemory } from '../memory/memory-helper.js';

type UsageFormat = 'anthropic_messages';

export interface MessagesAuthConfig {
  envVar: string;
  header: string;
  scheme?: string;
  template?: string;
}

export interface MessagesUsageConfig {
  format: UsageFormat;
}

export interface MessagesModelOptions {
  ensureAnthropicSuffix?: boolean;
}

export interface MessagesPassthroughConfig {
  provider: string;
  baseUrl: string;
  auth?: MessagesAuthConfig;
  staticHeaders?: Record<string, string>;
  supportedClientFormats: string[];
  modelOptions?: MessagesModelOptions;
  usage?: MessagesUsageConfig;
  forceStreamOption?: boolean;
  x402Enabled?: boolean;
}

interface StreamUsageSnapshot {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export class MessagesPassthrough {
  private initialUsage: StreamUsageSnapshot | null = null;
  private streamBuffer = '';
  private x402FetchFunction: typeof fetch | null = null;
  private x402Initialized = false;
  private lastX402PaymentAmount: string | undefined = undefined;
  private assistantResponseBuffer = '';

  constructor(private readonly config: MessagesPassthroughConfig) {
    // Initialize x402 payment wrapper once if needed
    this.initializeX402Support();
  }

  private async initializeX402Support(): Promise<void> {
    // Check if x402 is enabled for this provider (set by config loader)
    const { getConfig } = await import('../config/app-config.js');
    const config = getConfig();
    const shouldUseX402 = this.config.x402Enabled && config.x402.enabled;

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
          module: 'messages-passthrough',
        });
      } else {
        logger.error('x402 wallet initialization failed - getX402Account returned null', {
          provider: this.config.provider,
          module: 'messages-passthrough',
        });
      }
    } catch (error) {
      logger.error('Failed to initialize x402 payments', error, {
        provider: this.config.provider,
        errorMessage: error instanceof Error ? error.message : String(error),
        module: 'messages-passthrough',
      });
    } finally {
      this.x402Initialized = true;
    }
  }

  private resolveBaseUrl(): string {
    return this.config.baseUrl;
  }

  private resolvedKey: string | undefined;

  private get apiKey(): string | undefined {
    if (this.resolvedKey) return this.resolvedKey;
    if (!this.config.auth) return undefined;
    const envVar = this.config.auth.envVar;
    const token = process.env[envVar];
    if (!token) {
      throw new AuthenticationError(`${this.config.provider} API key not configured`, { provider: this.config.provider });
    }
    return token;
  }

  private buildAuthHeader(): string | undefined {
    const token = this.resolvedKey || this.apiKey;
    if (!token) return undefined;

    if (this.resolvedKey) return `Bearer ${this.resolvedKey}`;

    if (!this.config.auth) return undefined;
    const { scheme, template } = this.config.auth;

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
      ...this.config.staticHeaders,
    };

    try {
      const { resolveKeyForProvider } = await import('../auth/key-manager.js');
      this.resolvedKey = await resolveKeyForProvider(this.config.provider);
    } catch {
      this.resolvedKey = undefined;
    }

    if (this.resolvedKey && this.config.provider === 'anthropic') {
      headers['x-api-key'] = this.resolvedKey;
    } else if (this.config.auth) {
      const authHeader = this.buildAuthHeader();
      if (authHeader) {
        headers[this.config.auth.header] = authHeader;
      }
    }

    return headers;
  }

  private applyModelOptions(request: any): void {
    const modelOptions = this.config.modelOptions;
    if (!modelOptions) return;

    if (modelOptions.ensureAnthropicSuffix && typeof request.model === 'string') {
      request.model = ModelUtils.ensureAnthropicSuffix(request.model);
    }
  }

  /**
   * Recursively fix null or missing 'required' fields anywhere in an object.
   * xAI rejects required: null AND missing required in schemas, expects required: []
   */
  private sanitizeRequiredFields(obj: unknown): unknown {
    if (obj === null || obj === undefined) return obj;
    if (Array.isArray(obj)) return obj.map(item => this.sanitizeRequiredFields(item));
    if (typeof obj === 'object') {
      const result: Record<string, unknown> = {};
      const objRecord = obj as Record<string, unknown>;

      for (const [key, value] of Object.entries(objRecord)) {
        if (key === 'required' && value === null) {
          result[key] = [];
        } else {
          result[key] = this.sanitizeRequiredFields(value);
        }
      }

      // If this looks like a JSON schema object (has properties or type:object) but no required, add it
      const hasProperties = 'properties' in objRecord;
      const isObjectType = objRecord['type'] === 'object';
      const hasRequired = 'required' in result;

      if ((hasProperties || isObjectType) && !hasRequired) {
        result['required'] = [];
      }

      return result;
    }
    return obj;
  }

  private ensurePayloadBody(body: any, stream: boolean): any {
    // Strip fields not supported by Anthropic's public API
    // Claude Code sends these but they're only valid for internal/beta endpoints
    const { output_config, context_management, ...rest } = body;

    // Sanitize required: null to required: [] for xAI compatibility
    const sanitized = this.sanitizeRequiredFields(rest);

    // Debug: check if sanitization worked
    const jsonStr = JSON.stringify(sanitized);
    const hasRequiredNull = jsonStr.includes('"required":null');
    const hasRequiredNullSpaced = jsonStr.includes('"required": null');

    // Write full payload to file for inspection (per-provider)
    const provider = this.config.provider;
    require('fs').writeFileSync(`/tmp/payload-${provider}.json`, jsonStr);
    if (hasRequiredNull || hasRequiredNullSpaced) {
      require('fs').writeFileSync(`/tmp/bad-payload-${provider}.json`, jsonStr);
    }

    const result = this.config.forceStreamOption === false
      ? sanitized
      : { ...(sanitized as object), stream };

    // Log the FINAL result that will be stringified
    const finalJson = JSON.stringify(result);
    const finalHasNull = finalJson.includes('"required":null') || finalJson.includes('"required": null');
    require('fs').writeFileSync(`/tmp/final-${provider}.json`, finalJson);

    logger.info('PAYLOAD SANITIZATION', {
      provider,
      hasRequiredNull,
      hasRequiredNullSpaced,
      finalHasNull,
      payloadLength: finalJson.length,
      module: 'messages-passthrough',
    });

    return result;
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
        module: 'messages-passthrough',
      });
    } else {
      logger.info('Making request with API key authentication', {
        provider: this.config.provider,
        model: body?.model,
        baseUrl: this.config.baseUrl,
        apiKeyEnvVar: this.config.auth?.envVar,
        stream,
        module: 'messages-passthrough',
      });
    }

    let response: globalThis.Response;

    try {
      // Build payload and do final string-level sanitization
      let payloadJson = JSON.stringify(this.ensurePayloadBody(body, stream));

      // Bulletproof fix: replace ALL variations of required:null
      const beforeLen = payloadJson.length;
      payloadJson = payloadJson.replace(/"required"\s*:\s*null/g, '"required":[]');
      const fixed = beforeLen !== payloadJson.length;

      // Write final payload to file for debugging
      require('fs').writeFileSync(`/tmp/FINAL-${this.config.provider}-${Date.now()}.json`, payloadJson);

      // Double check - does it still have required:null?
      const stillHasNull = payloadJson.includes('required') && payloadJson.includes('null');
      logger.info('FINAL PAYLOAD CHECK', {
        provider: this.config.provider,
        fixed,
        stillHasNull,
        len: payloadJson.length,
        module: 'messages-passthrough'
      });

      response = await fetchFunction(this.resolveBaseUrl(), {
        method: 'POST',
        headers: await this.buildHeaders(),
        body: payloadJson,
      });
    } catch (error) {
      // Catch x402 payment errors (insufficient balance, payment failures, etc.)
      if (isX402Enabled) {
        logger.error('x402 payment request failed', error, {
          provider: this.config.provider,
          baseUrl: this.config.baseUrl,
          errorMessage: error instanceof Error ? error.message : String(error),
          module: 'messages-passthrough',
        });
      }
      throw error;
    }

    // Store fixed x402 cost for messages ($0.01 per request)
    // TODO: Replace with dynamically calculated amounts from x402 payment response
    if (isX402Enabled) {
      this.lastX402PaymentAmount = '0.01';
      
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
          module: 'messages-passthrough',
        });
        throw new PaymentError(
          errorText || 'Insufficient balance or payment error',
          { provider: this.config.provider, statusCode: response.status }
        );
      }
      
      // Standard error handling
      throw new ProviderError(
        this.config.provider,
        errorText || `HTTP ${response.status}`,
        response.status,
        { endpoint: this.resolveBaseUrl() }
      );
    }

    return response;
  }


  private trackUsage(payloadChunk: string, model: string, clientIp?: string): void {
    if (this.config.usage?.format !== 'anthropic_messages') {
      return;
    }

    try {
      this.streamBuffer += payloadChunk;
      const events = this.streamBuffer.split(/\n\n/);
      this.streamBuffer = events.pop() ?? '';

      for (const rawEvent of events) {
        const dataLines = rawEvent
          .split('\n')
          .filter(line => line.startsWith('data:'))
          .map(line => line.replace(/^data:\s?/, '').trim())
          .filter(Boolean);

        if (!dataLines.length) continue;

        const payload = dataLines.join('');
        if (!payload.startsWith('{')) continue;

        const data = JSON.parse(payload);
        
        // Don't accumulate from content_block_delta - we'll get the final response from message_delta/message_stop

        if (data.type === 'message_start' && data.message?.usage) {
          this.initialUsage = {
            inputTokens: data.message.usage.input_tokens || 0,
            cacheCreationTokens: data.message.usage.cache_creation_input_tokens || 0,
            cacheReadTokens: data.message.usage.cache_read_input_tokens || 0,
          };

          logger.debug('Usage tracking started', {
            provider: this.config.provider,
            model,
            ...this.initialUsage,
            module: 'messages-passthrough',
          });
          continue;
        }

        if (data.type === 'message_delta' || data.type === 'message_stop') {
          const usageData = data.usage;
          
          // Extract final response text from message_delta/message_stop event
          // Check if there's a message field with content
          if (data.message?.content && Array.isArray(data.message.content)) {
            const textContent = data.message.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text || '')
              .join('');
            if (textContent) {
              this.assistantResponseBuffer = textContent;
            }
          }

          if (usageData) {
            const inputTokens = usageData.input_tokens ?? this.initialUsage?.inputTokens ?? 0;
            const cacheCreationTokens = usageData.cache_creation_input_tokens ?? this.initialUsage?.cacheCreationTokens ?? 0;
            const cacheReadTokens = usageData.cache_read_input_tokens ?? this.initialUsage?.cacheReadTokens ?? 0;
            const outputTokens = usageData.output_tokens ?? 0;

            const usingFallback = !this.initialUsage;

            if (usingFallback) {
              logger.warn('Using fallback usage tracking', {
                provider: this.config.provider,
                reason: 'missed_message_start',
                model,
                inputTokens,
                cacheCreationTokens,
                cacheReadTokens,
                outputTokens,
                module: 'messages-passthrough',
              });
            }

            const usageSnapshot = {
              inputTokens,
              cacheCreationTokens,
              cacheReadTokens,
              outputTokens,
            };

            logger.debug('Usage tracking completed', {
              provider: this.config.provider,
              model,
              ...usageSnapshot,
              x402PaymentAmount: this.lastX402PaymentAmount,
              willUseX402Pricing: !!this.lastX402PaymentAmount,
              module: 'messages-passthrough',
            });

            import('../utils/usage-tracker.js')
              .then(({ usageTracker }) => {
                usageTracker.trackUsage(
                  model,
                  this.config.provider,
                  inputTokens,
                  outputTokens,
                  cacheCreationTokens,
                  cacheReadTokens,
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
                  module: 'messages-passthrough',
                });
              });

            this.initialUsage = null;
            continue;
          }

          if (!this.initialUsage) {
            continue;
          }
        }
      }
    } catch (error) {
      logger.error('Usage tracking failed', error, {
        provider: this.config.provider,
        operation: 'passthrough',
        module: 'messages-passthrough',
      });
    }
  }

  async handleDirectRequest(request: any, res: ExpressResponse, clientIp?: string): Promise<void> {
    this.initialUsage = null;
    this.streamBuffer = '';
    this.assistantResponseBuffer = '';
    this.lastX402PaymentAmount = undefined; // Reset payment amount for new request

    // Retrieve and inject memory context
    injectMemoryContext(request, {
      provider: this.config.provider,
      defaultUserId: 'default',
      extractCurrentUserInputs: req => extractAnthropicUserMessages(req),
      applyMemoryContext: (req, context) => {
        if (req.system) {
          req.system = `${context}\n\n---\n\n${req.system}`;
        } else {
          req.system = context;
        }
      }
    });

    this.applyModelOptions(request);

    if (request.stream) {
      const response = await this.makeRequest(request, true);

      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES.TEXT_PLAIN,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      const reader = response.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunkText = new TextDecoder().decode(value);
        setImmediate(() => this.trackUsage(chunkText, request.model, clientIp));

        res.write(value);
      }
      res.end();
      
      // Persist memory after streaming completes
      persistMemory(request, this.assistantResponseBuffer, {
        provider: this.config.provider,
        defaultUserId: 'default',
        minAssistantResponseLength: 3,
        filteredPatterns: [
          'User: test\n\nAssistant: Hello',
        ],
        extractUserContent: req => extractAnthropicLastUserContent(req),
        metadataBuilder: req => ({
          model: req.model,
          provider: this.config.provider,
        })
      });
      return;
    }

    const response = await this.makeRequest(request, false);
    const json = await response.json();

    if (json.usage && this.config.usage?.format === 'anthropic_messages') {
      const inputTokens = json.usage.input_tokens || 0;
      const cacheCreationTokens = json.usage.cache_creation_input_tokens || 0;
      const cacheReadTokens = json.usage.cache_read_input_tokens || 0;
      const outputTokens = json.usage.output_tokens || 0;

      logger.debug('Tracking non-streaming usage', {
        provider: this.config.provider,
        model: request.model,
        inputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        outputTokens,
        x402PaymentAmount: this.lastX402PaymentAmount,
        willUseX402Pricing: !!this.lastX402PaymentAmount,
        module: 'messages-passthrough',
      });

      import('../utils/usage-tracker.js')
        .then(({ usageTracker }) => {
          usageTracker.trackUsage(
            request.model,
            this.config.provider,
            inputTokens,
            outputTokens,
            cacheCreationTokens,
            cacheReadTokens,
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
            module: 'messages-passthrough',
          });
        });
    }

    // Extract assistant response from non-streaming response
    const assistantResponse = json?.content?.[0]?.text || '';
    persistMemory(request, assistantResponse, {
      provider: this.config.provider,
      defaultUserId: 'default',
      minAssistantResponseLength: 3,
      filteredPatterns: [
        'User: test\n\nAssistant: Hello',
      ],
      extractUserContent: req => extractAnthropicLastUserContent(req),
      metadataBuilder: req => ({
        model: req.model,
        provider: this.config.provider,
      })
    });

    res.json(json);
  }
  
}

function formatAnthropicMessageContent(content: any): string {
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    raw = content.map((c: any) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(' ');
  } else {
    raw = JSON.stringify(content);
  }
  return stripSystemReminders(raw).trim();
}

function extractAnthropicUserMessages(request: any): string[] {
  const currentMessages = request.messages || [];
  return currentMessages
    .filter((msg: any) => msg.role === 'user')
    .map((msg: any) => formatAnthropicMessageContent(msg.content))
    .filter(Boolean);
}

function extractAnthropicLastUserContent(request: any): string | null {
  const messages = request.messages || [];
  const userMessages = messages.filter((msg: any) => msg.role === 'user');
  if (!userMessages.length) {
    return null;
  }
  const lastUserMessage = userMessages[userMessages.length - 1];
  const formatted = formatAnthropicMessageContent(lastUserMessage.content);
  return formatted || null;
}

function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '').trim();
}
