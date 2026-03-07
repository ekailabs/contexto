import { logger } from '../utils/logger.js';
import { memoryService } from './memory-service.js';

const DEFAULT_USER_ID = 'default';
const LOG_MODULE = 'memory-helper';

function extractUserContentFromMemory(memoryContent: string): string | null {
  const match = memoryContent.match(/^User: ([\s\S]*?)\n\nAssistant:/);
  return match ? match[1].trim() : null;
}

function resolveUserId<T>(request: T, getUserId?: (req: T) => string | undefined, defaultUserId?: string): string {
  const resolved = getUserId?.(request)?.trim();
  return resolved || defaultUserId || DEFAULT_USER_ID;
}

export interface MemoryContextOptions<TRequest = any> {
  provider: string;
  extractCurrentUserInputs: (request: TRequest) => string[];
  applyMemoryContext: (request: TRequest, context: string) => void;
  getUserId?: (request: TRequest) => string | undefined;
  defaultUserId?: string;
  retrieveLimit?: number;
}

export interface MemoryPersistenceOptions<TRequest = any> {
  provider: string;
  extractUserContent: (request: TRequest) => string | null;
  metadataBuilder?: (request: TRequest) => Record<string, unknown>;
  getUserId?: (request: TRequest) => string | undefined;
  defaultUserId?: string;
  filteredPatterns?: string[];
  minAssistantResponseLength?: number;
}

export function injectMemoryContext<TRequest = any>(request: TRequest, options: MemoryContextOptions<TRequest>): void {
  try {
    const userId = resolveUserId(request, options.getUserId, options.defaultUserId);
    const memories = memoryService.retrieve({
      userId,
      limit: options.retrieveLimit,
    });

    logger.info('Memory retrieval result', {
      provider: options.provider,
      userId,
      totalMemories: memories.length,
      module: LOG_MODULE,
    });

    if (!memories.length) {
      return;
    }

    const currentEntries = options
      .extractCurrentUserInputs(request)
      .map(entry => entry.trim())
      .filter(Boolean);

    const relevantMemories = memories.filter(memory => {
      const userContent = extractUserContentFromMemory(memory.content);
      return userContent ? !currentEntries.includes(userContent) : false;
    });

    if (!relevantMemories.length) {
      logger.info('No new memories to inject after deduplication', {
        provider: options.provider,
        userId,
        totalMemories: memories.length,
        currentUserMessages: currentEntries.length,
        module: LOG_MODULE,
      });
      return;
    }

    const formattedMemories = relevantMemories
      .slice()
      .reverse()
      .map(memory => memory.content)
      .join('\n\n---\n\n');

    const memoryContext = `Previous conversation context:\n\n${formattedMemories}`;

    options.applyMemoryContext(request, memoryContext);

    logger.info('Memory context injected', {
      provider: options.provider,
      userId,
      injectedCount: relevantMemories.length,
      module: LOG_MODULE,
    });
  } catch (error) {
    logger.warn('Failed to inject memory context', {
      provider: options.provider,
      error,
      module: LOG_MODULE,
    });
  }
}

export function persistMemory<TRequest = any>(
  request: TRequest,
  assistantResponse: string,
  options: MemoryPersistenceOptions<TRequest>
): void {
  try {
    const trimmedAssistant = assistantResponse?.trim?.() ?? '';
    if (!trimmedAssistant) {
      logger.debug('Skipping memory persistence - assistant response empty', {
        provider: options.provider,
        module: LOG_MODULE,
      });
      return;
    }

    if (
      options.minAssistantResponseLength &&
      trimmedAssistant.length < options.minAssistantResponseLength
    ) {
      return;
    }

    const userContent = options.extractUserContent(request);
    const trimmedUserContent = userContent?.trim();

    if (!trimmedUserContent) {
      logger.debug('Skipping memory persistence - user content empty', {
        provider: options.provider,
        module: LOG_MODULE,
      });
      return;
    }

    const content = `User: ${trimmedUserContent}\n\nAssistant: ${trimmedAssistant}`;

    if (options.filteredPatterns?.includes(content)) {
      return;
    }

    const userId = resolveUserId(request, options.getUserId, options.defaultUserId);

    memoryService.add({
      userId,
      agentId: options.provider,
      content,
      metadata: options.metadataBuilder?.(request) ?? { provider: options.provider },
    });

    logger.debug('Memory persisted', {
      provider: options.provider,
      userId,
      module: LOG_MODULE,
    });
  } catch (error) {
    logger.warn('Failed to persist memory', {
      provider: options.provider,
      error,
      module: LOG_MODULE,
    });
  }
}
