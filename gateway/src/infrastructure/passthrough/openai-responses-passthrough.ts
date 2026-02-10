import { Response as ExpressResponse } from 'express';
import { logger } from '../utils/logger.js';
import { AuthenticationError, ProviderError } from '../../shared/errors/index.js';
import { CONTENT_TYPES } from '../../domain/types/provider.js';
import { getConfig } from '../config/app-config.js';
import { ResponsesPassthrough, ResponsesPassthroughConfig } from './responses-passthrough.js';
import { injectMemoryContext, persistMemory } from '../memory/memory-helper.js';

export class OpenAIResponsesPassthrough implements ResponsesPassthrough {
  constructor(private readonly config: ResponsesPassthroughConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl;
  }

  private oauthToken: string | undefined;

  private async resolveOAuthToken(): Promise<string | undefined> {
    if (this.config.provider !== 'openai') return undefined;
    try {
      const { getValidAccessToken } = await import('../auth/oauth-service.js');
      return await getValidAccessToken('openai');
    } catch {
      return undefined;
    }
  }

  private get apiKey(): string {
    if (this.oauthToken) return this.oauthToken;

    const envVar = this.config.auth?.envVar;
    if (envVar) {
      const token = process.env[envVar];
      if (token) return token;
    }

    const fallback = getConfig().providers.openai.apiKey;
    if (fallback) return fallback;

    throw new AuthenticationError('OpenAI API key not configured', { provider: this.config.provider });
  }

  private buildAuthHeader(): string {
    if (this.oauthToken) {
      return `Bearer ${this.oauthToken}`;
    }

    const token = this.apiKey;
    const { auth } = this.config;
    if (!auth) {
      return `Bearer ${token}`;
    }

    if (auth.template) {
      return auth.template.replace('{{token}}', token);
    }

    if (auth.scheme) {
      return `${auth.scheme} ${token}`.trim();
    }

    return token;
  }

  private async buildHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.staticHeaders,
    };

    this.oauthToken = await this.resolveOAuthToken();

    const headerName = this.config.auth?.header ?? 'Authorization';
    headers[headerName] = this.buildAuthHeader();
    return headers;
  }

  // Store usage data for tracking
  private usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null = null;

  // Buffer to handle multi-chunk SSE events
  private eventBuffer: string = '';
  private assistantResponseBuffer: string = '';

  private async makeRequest(body: any, stream: boolean): Promise<globalThis.Response> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: await this.buildHeaders(),
      body: JSON.stringify({ ...body, stream, store: false }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderError('openai', errorText || `HTTP ${response.status}`, response.status, { endpoint: this.baseUrl });
    }

    return response;
  }

  private trackUsage(text: string, model: string, clientIp?: string): void {
    try {
      // Add to buffer to handle multi-chunk events
      this.eventBuffer += text;
      
      // Extract assistant response content from text.delta events
      const textDeltaMatch = /"type":"response\.text\.delta"[^}]*"text":"([^"]+)"/g;
      let match;
      while ((match = textDeltaMatch.exec(text)) !== null) {
        this.assistantResponseBuffer += match[1];
      }
      
      // Look for the exact response.completed event
      if (this.eventBuffer.includes('"type":"response.completed"')) {
        
        // Find the start of the JSON object
        const startIndex = this.eventBuffer.indexOf('{"type":"response.completed"');
        if (startIndex === -1) return;
        
        // Find the end by counting braces
        let braceCount = 0;
        let endIndex = -1;
        
        for (let i = startIndex; i < this.eventBuffer.length; i++) {
          if (this.eventBuffer[i] === '{') braceCount++;
          if (this.eventBuffer[i] === '}') braceCount--;
          
          if (braceCount === 0) {
            endIndex = i;
            break;
          }
        }
        
        if (endIndex === -1) return; // Incomplete JSON, wait for more chunks
        
        // Extract the complete JSON
        const jsonString = this.eventBuffer.substring(startIndex, endIndex + 1);
        
        logger.debug('JSON response found', { provider: 'openai', operation: 'response_parsing', module: 'openai-responses-passthrough' });
        
        try {
          const data = JSON.parse(jsonString);
          logger.debug('Response parsed successfully', { provider: 'openai', operation: 'usage_extraction', module: 'openai-responses-passthrough' });
          
          // Extract usage data from response.usage
          if (data.response?.usage) {
            const usage = data.response.usage;
            const totalInputTokens = usage.input_tokens || 0;
            const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
            const nonCachedInputTokens = totalInputTokens - cachedTokens; // Split for pricing
            const outputTokens = usage.output_tokens || 0;
            const totalTokens = usage.total_tokens || (totalInputTokens + outputTokens);
            const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;

            logger.debug('Usage tracking from response', {
              provider: 'openai',
              model,
              totalInputTokens,
              nonCachedInputTokens,
              cachedTokens,
              outputTokens,
              totalTokens,
              reasoningTokens,
              module: 'openai-responses-passthrough'
            });

            import('../utils/usage-tracker.js').then(({ usageTracker }) => {
              usageTracker.trackUsage(
                model,
                'openai',
                nonCachedInputTokens, // Send non-cached input tokens for correct pricing
                outputTokens,
                cachedTokens,         // Send cached tokens separately for correct pricing
                0, // cache read tokens
                clientIp
              );
            }).catch((error) => {
              logger.error('Usage tracking failed', error, { provider: 'openai', operation: 'passthrough', module: 'openai-responses-passthrough' });
            });
          } else {
            logger.warn('No usage data in response', { provider: 'openai', operation: 'passthrough', module: 'openai-responses-passthrough' });
          }
        } catch (parseError) {
          logger.error('JSON parse error', parseError, { provider: 'openai', operation: 'response_parsing', module: 'openai-responses-passthrough' });
          logger.debug('Raw JSON data', { provider: 'openai', operation: 'response_parsing', module: 'openai-responses-passthrough' });
        }
        
        // Clear buffer after processing
        this.eventBuffer = '';
      }
    } catch (error) {
      logger.error('Usage tracking failed', error, { provider: 'openai', operation: 'passthrough', module: 'openai-responses-passthrough' });
    }
  }

  async handleDirectRequest(request: any, res: ExpressResponse, clientIp?: string): Promise<void> {
    // Reset usage tracking for new request
    this.usage = null;
    this.eventBuffer = '';
    this.assistantResponseBuffer = '';

    injectMemoryContext(request, {
      provider: this.config.provider,
      defaultUserId: 'default',
      extractCurrentUserInputs: req => extractResponsesUserInputs(req),
      applyMemoryContext: (req, context) => {
        if (req.instructions) {
          req.instructions = `${context}\n\n---\n\n${req.instructions}`;
        } else {
          req.instructions = context;
        }
      }
    });

    if (request.stream) {
      const response = await this.makeRequest(request, true);

      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES.EVENT_STREAM,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      // Manual stream processing like Anthropic for usage tracking
      const reader = response.body!.getReader();
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const text = new TextDecoder().decode(value);
        setImmediate(() => this.trackUsage(text, request.model, clientIp));
        
        res.write(value);
      }
      res.end();

      persistMemory(request, this.assistantResponseBuffer, {
        provider: this.config.provider,
        defaultUserId: 'default',
        extractUserContent: req => req.input || '',
        metadataBuilder: req => ({
          model: req.model,
          provider: this.config.provider,
        }),
      });
    } else {
      const response = await this.makeRequest(request, false);
      const json = await response.json();

      // Track usage for non-streaming requests
      if (json.usage) {
        const totalInputTokens = json.usage.input_tokens || 0;
        const cachedTokens = json.usage.input_tokens_details?.cached_tokens || 0;
        const nonCachedInputTokens = totalInputTokens - cachedTokens; // Split for pricing
        const outputTokens = json.usage.output_tokens || 0;
        const totalTokens = json.usage.total_tokens || (totalInputTokens + outputTokens);
        const reasoningTokens = json.usage.output_tokens_details?.reasoning_tokens || 0;

        logger.debug('Tracking non-streaming usage', {
          provider: 'openai',
          model: request.model,
          totalInputTokens,
          nonCachedInputTokens,
          cachedTokens,
          outputTokens,
          totalTokens,
          reasoningTokens,
          module: 'openai-responses-passthrough'
        });

        import('../utils/usage-tracker.js').then(({ usageTracker }) => {
          usageTracker.trackUsage(request.model, 'openai', nonCachedInputTokens, outputTokens, cachedTokens, 0, clientIp);
        }).catch(() => {});
      }

      const assistantResponse = json?.output?.[0]?.content?.[0]?.text || '';
      persistMemory(request, assistantResponse, {
        provider: this.config.provider,
        defaultUserId: 'default',
        extractUserContent: req => req.input || '',
        metadataBuilder: req => ({
          model: req.model,
          provider: this.config.provider,
        }),
      });

      res.json(json);
    }
  }
}

function extractResponsesUserInputs(request: any): string[] {
  const content = (request.input || '').trim();
  return content ? [content] : [];
}
