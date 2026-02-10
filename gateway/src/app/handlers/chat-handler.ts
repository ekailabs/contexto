import { Request, Response } from 'express';
import { ProviderService } from '../../domain/services/provider-service.js';
import { OpenAIAdapter } from '../../infrastructure/adapters/openai-adapter.js';
import { OpenAIResponsesAdapter } from '../../infrastructure/adapters/openai-responses-adapter.js';
import { AnthropicAdapter } from '../../infrastructure/adapters/anthropic-adapter.js';
import { handleError } from '../../infrastructure/utils/error-handler.js';
import { ValidationError, ConfigurationError } from '../../shared/errors/index.js';
import { logger } from '../../infrastructure/utils/logger.js';
import { HTTP_STATUS, CONTENT_TYPES } from '../../domain/types/provider.js';
import { ModelUtils } from '../../infrastructure/utils/model-utils.js';
import { CanonicalRequest } from 'shared/types/index.js';
import { createChatCompletionsPassthroughRegistry } from '../../infrastructure/passthrough/chat-completions-passthrough-registry.js';
import { createMessagesPassthroughRegistry } from '../../infrastructure/passthrough/messages-passthrough-registry.js';
import { createResponsesPassthroughRegistry } from '../../infrastructure/passthrough/responses-passthrough-registry.js';
import { getResponsesProviderForModel } from '../../infrastructure/passthrough/responses-provider-config.js';
import { budgetService } from '../../domain/services/budget-service.js';

type ClientFormat = 'openai' | 'anthropic' | 'openai_responses';
type ProviderName = string;

interface StreamingHeaders {
  'Content-Type': string;
  'Cache-Control': string;
  'Connection': string;
  'Access-Control-Allow-Origin': string;
}

const chatCompletionsPassthroughRegistry = createChatCompletionsPassthroughRegistry();
const messagesPassthroughRegistry = createMessagesPassthroughRegistry();
const responsesPassthroughRegistry = createResponsesPassthroughRegistry();

export class ChatHandler {
  constructor(
    private readonly providerService: ProviderService,
    private readonly adapters: {
      openai: OpenAIAdapter;
      anthropic: AnthropicAdapter;
      openai_responses: OpenAIResponsesAdapter;
    }
  ) {}

  private bestClientIp(req: Request): string | undefined {
    const xff = (req.headers['x-forwarded-for'] || '') as string;
    const cf = (req.headers['cf-connecting-ip'] || '') as string;
    const xri = (req.headers['x-real-ip'] || '') as string;
    const forwarded = xff.split(',').map(s => s.trim()).filter(Boolean)[0];
    const fromHeaders = forwarded || cf || xri;
    const fromReq = (req as any).clientIp || (req as any).ip || (req.socket as any)?.remoteAddress;
    return fromHeaders || fromReq;
  }

  async handleChatRequest(req: Request, res: Response, clientFormat: ClientFormat): Promise<void> {
    try {
      logger.debug('Processing chat request', { requestId: req.requestId, module: 'chat-handler' });
      const originalRequest = req.body;
      const clientIp = this.bestClientIp(req);

      // For OpenAI responses, we need to determine if we should use passthrough
      // This requires provider selection logic
      let providerName: ProviderName;
      let canonicalRequest: CanonicalRequest;

      if (clientFormat === 'openai_responses') {
        providerName = getResponsesProviderForModel(req.body.model || '');
        canonicalRequest = this.adapters[clientFormat].toCanonical(req.body);

        logger.debug('Processing OpenAI Responses request', {
          requestId: req.requestId,
          clientFormat,
          model: canonicalRequest.model,
          streaming: canonicalRequest.stream,
          provider: providerName,
          module: 'chat-handler'
        });
      } else {
        // Normal flow for other client formats
        const result = this.providerService.getMostOptimalProvider(req.body.model, req.requestId);
        if (result.error) {
          if (result.error.code === 'NO_PROVIDERS_CONFIGURED') {
            throw new ConfigurationError(result.error.message, { code: result.error.code });
          }
          throw new ValidationError(result.error.message, { code: result.error.code, model: req.body.model });
        }

        providerName = result.provider;
        canonicalRequest = this.adapters[clientFormat].toCanonical(req.body);
      }

      // Enforce global monthly budget (disabled when no cap is set)
      budgetService.enforceBudget(0, req.requestId);

      // Normalize model name, example: anthropic/claude-3-5-sonnet → claude-3-5-sonnet.
      // will need to move it to normalization canonical step in future
      if (req.body.model.includes(providerName)) {
        req.body.model = ModelUtils.removeProviderPrefix(req.body.model);
      }

      // Pass-through scenarios: where clientFormat and providerFormat are the same, we want to take a quick route
      // Currently supporting claude code proxy through pass-through, i.e., we skip the canonicalization step
      const passThrough = this.shouldUsePassThrough(clientFormat, providerName);

      logger.info('Chat request received', {
        requestId: req.requestId,
        model: req.body.model,
        provider: providerName,
        streaming: req.body.stream,
        passThrough,
        module: 'chat-handler'
      });

      if (passThrough) {
        
        await this.handlePassThrough(originalRequest, res, clientFormat, providerName, clientIp);
        return;
      }

      // For non-passthrough cases, ensure we have canonical request
      if (clientFormat !== 'openai_responses') {
        canonicalRequest = this.adapters[clientFormat].toCanonical(req.body);
      }

      if (canonicalRequest.stream) {
        await this.handleStreaming(canonicalRequest, res, clientFormat, providerName, originalRequest, req, clientIp);
      } else {
        await this.handleNonStreaming(canonicalRequest, res, clientFormat, providerName, originalRequest, req, clientIp);
      }
    } catch (error) {
      logger.error('Chat request failed', error, { requestId: req.requestId, module: 'chat-handler' });
      const errorFormat = clientFormat === 'openai_responses' ? 'openai' : clientFormat;
      handleError(error, res, errorFormat);
    }
  }


  private async handleNonStreaming(canonicalRequest: CanonicalRequest, res: Response, clientFormat: ClientFormat, providerName?: ProviderName, originalRequest?: any, req?: Request, clientIp?: string): Promise<void> {
    if (clientFormat === 'openai_responses') {
      const canonicalResponse = await this.providerService.processChatCompletion(canonicalRequest, 'openai' as any, 'openai', originalRequest, req.requestId, clientIp);
      const clientResponse = this.adapters[clientFormat].fromCanonical(canonicalResponse);
      res.status(HTTP_STATUS.OK).json(clientResponse);
      return;
    }

    const canonicalResponse = await this.providerService.processChatCompletion(canonicalRequest, providerName as any, clientFormat, originalRequest, req.requestId, clientIp);
    const clientResponse = this.adapters[clientFormat].fromCanonical(canonicalResponse);

    res.status(HTTP_STATUS.OK).json(clientResponse);
  }

  private async handleStreaming(canonicalRequest: CanonicalRequest, res: Response, clientFormat: ClientFormat, providerName?: ProviderName, originalRequest?: any, req?: Request, clientIp?: string): Promise<void> {
    if (clientFormat === 'openai_responses') {
      const streamResponse = await this.providerService.processStreamingRequest(canonicalRequest, 'openai' as any, 'openai', originalRequest, req.requestId, clientIp);

      res.writeHead(HTTP_STATUS.OK, {
        'Content-Type': CONTENT_TYPES.EVENT_STREAM,
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });

      if (streamResponse?.body) {
        streamResponse.body.pipe(res);
      } else {
        throw new Error('No stream body received from provider');
      }
      return;
    }

    const streamResponse = await this.providerService.processStreamingRequest(canonicalRequest, providerName as any, clientFormat, originalRequest, req.requestId, clientIp);

    this.setStreamingHeaders(res);

    if (streamResponse?.body) {
      streamResponse.body.pipe(res);
    } else {
      throw new Error('No stream body received from provider');
    }
  }

  // Pass-through scenarios: where clientFormat and providerFormat are the same, we want to take a quick route
  // Currently supporting native provider formats via chat completions/messages passthroughs
  private shouldUsePassThrough(clientFormat: ClientFormat, providerName: ProviderName): boolean {
    const responsesFormats = responsesPassthroughRegistry.getSupportedClientFormats(providerName);
    if (responsesFormats.includes(clientFormat)) {
      return true;
    }

    const chatConfig = chatCompletionsPassthroughRegistry.getConfig(providerName);
    if (chatConfig?.supportedClientFormats.includes(clientFormat)) {
      return true;
    }

    const messagesConfig = messagesPassthroughRegistry.getConfig(providerName);
    return Boolean(messagesConfig?.supportedClientFormats.includes(clientFormat));
  }

  private setStreamingHeaders(res: Response): void {
    const headers = {
      'Content-Type': CONTENT_TYPES.TEXT_PLAIN,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    };
    res.writeHead(HTTP_STATUS.OK, headers);
  }

  private async handlePassThrough(originalRequest: any, res: Response, clientFormat: ClientFormat, providerName: ProviderName, clientIp?: string): Promise<void> {
    const responsesPassthrough = responsesPassthroughRegistry.getPassthrough(providerName);
    const responsesSupportsFormat = responsesPassthroughRegistry
      .getSupportedClientFormats(providerName)
      .includes(clientFormat);

    if (responsesPassthrough && responsesSupportsFormat) {
      await responsesPassthrough.handleDirectRequest(originalRequest, res, clientIp);
      return;
    }

    const chatPassthrough = chatCompletionsPassthroughRegistry.getPassthrough(providerName);
    const chatSupportsFormat = chatCompletionsPassthroughRegistry
      .getSupportedClientFormats(providerName)
      .includes(clientFormat);

    if (chatPassthrough && chatSupportsFormat) {
      await chatPassthrough.handleDirectRequest(originalRequest, res, clientIp);
      return;
    }

    const passthrough = messagesPassthroughRegistry.getPassthrough(providerName);
    const supportsFormat = messagesPassthroughRegistry
      .getSupportedClientFormats(providerName)
      .includes(clientFormat);

    if (!passthrough || !supportsFormat) {
      throw new ConfigurationError(`Passthrough not configured for provider ${providerName}`, { provider: providerName, format: clientFormat });
    }

    await passthrough.handleDirectRequest(originalRequest, res, clientIp);
  }

}

// Factory function
export function createChatHandler(): ChatHandler {
  const providerService = new ProviderService();
  const adapters = {
    openai: new OpenAIAdapter(),
    anthropic: new AnthropicAdapter(),
    openai_responses: new OpenAIResponsesAdapter()
  };

  return new ChatHandler(providerService, adapters);
}
// Singleton instance
const chatHandler = createChatHandler();

// Endpoint functions
export const handleOpenAIFormatChat = async (req: Request, res: Response): Promise<void> => {
  await chatHandler.handleChatRequest(req, res, 'openai');
};

export const handleAnthropicFormatChat = async (req: Request, res: Response): Promise<void> => {
  await chatHandler.handleChatRequest(req, res, 'anthropic');
};

export const handleOpenAIResponses = async (req: Request, res: Response): Promise<void> => {
  await chatHandler.handleChatRequest(req, res, 'openai_responses');
};
