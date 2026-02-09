import { Response as ExpressResponse } from 'express';
import { logger } from '../utils/logger.js';
import { AuthenticationError, ProviderError } from '../../shared/errors/index.js';
import { CONTENT_TYPES } from '../../domain/types/provider.js';
import { getConfig } from '../config/app-config.js';
import { ResponsesPassthrough, ResponsesPassthroughConfig } from './responses-passthrough.js';
import { injectMemoryContext, persistMemory } from '../memory/memory-helper.js';

export class OllamaResponsesPassthrough implements ResponsesPassthrough {
  constructor(private readonly config: ResponsesPassthroughConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl;
  }

  private get apiKey(): string | undefined {
    const envVar = this.config.auth?.envVar;
    if (envVar) {
      const token = process.env[envVar];
      if (token) return token;
    }

    // Ollama doesn't require an API key by default (runs locally)
    // Return undefined if no key is configured
    return getConfig().providers.ollama.apiKey;
  }

  private buildAuthHeader(): string | undefined {
    const token = this.apiKey;
    if (!token) return undefined; // Ollama doesn't require auth by default

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

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.staticHeaders,
    };

    const authHeader = this.buildAuthHeader();
    if (authHeader) {
      const headerName = this.config.auth?.header ?? 'Authorization';
      headers[headerName] = authHeader;
    }

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
      headers: this.buildHeaders(),
      body: JSON.stringify({ ...body, stream, store: false }) // Not storing responses
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderError('ollama', errorText || `HTTP ${response.status}`, response.status, { endpoint: this.baseUrl });
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
        
        logger.debug('JSON response found', { provider: 'ollama', operation: 'response_parsing', module: 'ollama-responses-passthrough' });
        
        try {
          const data = JSON.parse(jsonString);
          logger.debug('Response parsed successfully', { provider: 'ollama', operation: 'usage_extraction', module: 'ollama-responses-passthrough' });
          
          // Extract usage data from response.usage
          if (data.response?.usage) {
            const usage = data.response.usage;
            const totalInputTokens = usage.input_tokens || 0;
            const cachedTokens = usage.input_tokens_details?.cached_tokens || 0;
            const nonCachedInputTokens = totalInputTokens - cachedTokens;
            const outputTokens = usage.output_tokens || 0;
            const totalTokens = usage.total_tokens || (totalInputTokens + outputTokens);
            const reasoningTokens = usage.output_tokens_details?.reasoning_tokens || 0;

            logger.debug('Usage tracking from response', {
              provider: 'ollama',
              model,
              totalInputTokens,
              nonCachedInputTokens,
              cachedTokens,
              outputTokens,
              totalTokens,
              reasoningTokens,
              module: 'ollama-responses-passthrough'
            });

            import('../utils/usage-tracker.js').then(({ usageTracker }) => {
              usageTracker.trackUsage(
                model,
                'ollama',
                nonCachedInputTokens,
                outputTokens,
                cachedTokens,
                0, // cache read tokens
                clientIp
              );
            }).catch((error) => {
              logger.error('Usage tracking failed', error, { provider: 'ollama', operation: 'passthrough', module: 'ollama-responses-passthrough' });
            });
          } else {
            logger.warn('No usage data in response', { provider: 'ollama', operation: 'passthrough', module: 'ollama-responses-passthrough' });
          }
        } catch (parseError) {
          logger.error('JSON parse error', parseError, { provider: 'ollama', operation: 'response_parsing', module: 'ollama-responses-passthrough' });
        }
        
        // Clear buffer after processing
        this.eventBuffer = '';
      }
    } catch (error) {
      logger.error('Usage tracking failed', error, { provider: 'ollama', operation: 'passthrough', module: 'ollama-responses-passthrough' });
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

      // Manual stream processing for usage tracking
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
        const nonCachedInputTokens = totalInputTokens - cachedTokens;
        const outputTokens = json.usage.output_tokens || 0;
        const totalTokens = json.usage.total_tokens || (totalInputTokens + outputTokens);
        const reasoningTokens = json.usage.output_tokens_details?.reasoning_tokens || 0;

        logger.debug('Tracking non-streaming usage', {
          provider: 'ollama',
          model: request.model,
          totalInputTokens,
          nonCachedInputTokens,
          cachedTokens,
          outputTokens,
          totalTokens,
          reasoningTokens,
          module: 'ollama-responses-passthrough'
        });

        import('../utils/usage-tracker.js').then(({ usageTracker }) => {
          usageTracker.trackUsage(request.model, 'ollama', nonCachedInputTokens, outputTokens, cachedTokens, 0, clientIp);
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
