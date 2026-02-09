import { Response as ExpressResponse } from 'express';
import { logger } from '../utils/logger.js';
import { ProviderError } from '../../shared/errors/index.js';
import { CONTENT_TYPES } from '../../domain/types/provider.js';
import { getConfig } from '../config/app-config.js';
import { ResponsesPassthrough, ResponsesPassthroughConfig } from './responses-passthrough.js';
import { injectMemoryContext, persistMemory } from '../memory/memory-helper.js';

export class OllamaResponsesPassthrough implements ResponsesPassthrough {
  constructor(private readonly config: ResponsesPassthroughConfig) {}

  private get baseUrl(): string {
    if (this.config.baseUrl) {
      return this.config.baseUrl;
    }
    const configBaseUrl = getConfig().providers.ollama.baseUrl;
    return configBaseUrl.replace(/\/v1\/?$/, '/v1/responses');
  }

  private buildAuthHeader(): string {
    const { auth } = this.config;
    if (!auth) {
      return '';
    }

    const envVar = auth.envVar;
    if (envVar) {
      const token = process.env[envVar];
      if (token) {
        if (auth.scheme) {
          return `${auth.scheme} ${token}`.trim();
        }
        return token;
      }
    }

    return '';
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.staticHeaders,
    };

    const headerName = this.config.auth?.header ?? 'Authorization';
    const authHeader = this.buildAuthHeader();
    if (authHeader) {
      headers[headerName] = authHeader;
    }
    return headers;
  }

  private usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  } | null = null;

  private eventBuffer: string = '';
  private assistantResponseBuffer: string = '';

  private async makeRequest(body: any, stream: boolean): Promise<globalThis.Response> {
    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ ...body, stream, store: false })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new ProviderError('ollama', errorText || `HTTP ${response.status}`, response.status, { endpoint: this.baseUrl });
    }

    return response;
  }

  private trackUsage(text: string, model: string, clientIp?: string): void {
    try {
      this.eventBuffer += text;
      
      const textDeltaMatch = /"type":"response\.text\.delta"[^}]*"text":"([^"]+)"/g;
      let match;
      while ((match = textDeltaMatch.exec(text)) !== null) {
        this.assistantResponseBuffer += match[1];
      }
      
      if (this.eventBuffer.includes('"type":"response.completed"')) {
        const startIndex = this.eventBuffer.indexOf('{"type":"response.completed"');
        if (startIndex === -1) return;
        
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
        
        if (endIndex === -1) return;
        
        const jsonString = this.eventBuffer.substring(startIndex, endIndex + 1);
        
        logger.debug('JSON response found', { provider: 'ollama', operation: 'response_parsing', module: 'ollama-responses-passthrough' });
        
        try {
          const data = JSON.parse(jsonString);
          logger.debug('Response parsed successfully', { provider: 'ollama', operation: 'usage_extraction', module: 'ollama-responses-passthrough' });
          
          if (data.response?.usage) {
            const usage = data.response.usage;
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            const totalTokens = usage.total_tokens || (inputTokens + outputTokens);

            logger.debug('Usage tracking from response', {
              provider: 'ollama',
              model,
              inputTokens,
              outputTokens,
              totalTokens,
              module: 'ollama-responses-passthrough'
            });

            import('../utils/usage-tracker.js').then(({ usageTracker }) => {
              usageTracker.trackUsage(
                model,
                'ollama',
                inputTokens,
                outputTokens,
                0,
                0,
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
        
        this.eventBuffer = '';
      }
    } catch (error) {
      logger.error('Usage tracking failed', error, { provider: 'ollama', operation: 'passthrough', module: 'ollama-responses-passthrough' });
    }
  }

  async handleDirectRequest(request: any, res: ExpressResponse, clientIp?: string): Promise<void> {
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

      if (json.usage) {
        const inputTokens = json.usage.input_tokens || 0;
        const outputTokens = json.usage.output_tokens || 0;
        const totalTokens = json.usage.total_tokens || (inputTokens + outputTokens);

        logger.debug('Tracking non-streaming usage', {
          provider: 'ollama',
          model: request.model,
          inputTokens,
          outputTokens,
          totalTokens,
          module: 'ollama-responses-passthrough'
        });

        import('../utils/usage-tracker.js').then(({ usageTracker }) => {
          usageTracker.trackUsage(request.model, 'ollama', inputTokens, outputTokens, 0, 0, clientIp);
        }).catch(() => {});
      }

      const assistantResponse = json?.output?.[0]?.content?.[0]?.text || json?.output_text || '';
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
