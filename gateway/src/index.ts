// Load environment variables before importing modules
import dotenv from 'dotenv';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Find project root by looking for package.json (works in both dev and prod)
function findProjectRoot(startPath: string): string {
  let currentPath = startPath;
  while (currentPath !== dirname(currentPath)) {
    if (existsSync(join(currentPath, 'package.json')) && 
        existsSync(join(currentPath, '.env.example'))) {
      return currentPath;
    }
    currentPath = dirname(currentPath);
  }
  // Fallback to process.cwd() if not found
  return process.cwd();
}

const projectRoot = findProjectRoot(__dirname);
dotenv.config({ path: join(projectRoot, '.env') });

// Import application modules
import express from 'express';
import cors from 'cors';
import { handleOpenAIFormatChat, handleAnthropicFormatChat, handleOpenAIResponses } from './app/handlers/chat-handler.js';
import { handleUsageRequest } from './app/handlers/usage-handler.js';
import { handleConfigStatus } from './app/handlers/config-handler.js';
import { handleModelsRequest } from './app/handlers/models-handler.js';
import { handleGetBudget, handleUpdateBudget } from './app/handlers/budget-handler.js';
import { handleListKeys, handleAddKey, handleRemoveKey, handleUpdateKeyPriority } from './app/handlers/key-handler.js';
import { logger } from './infrastructure/utils/logger.js';
import { requestContext } from './infrastructure/middleware/request-context.js';
import { requestLogging } from './infrastructure/middleware/request-logging.js';
import { ProviderService } from './domain/services/provider-service.js';
import { pricingLoader } from './infrastructure/utils/pricing-loader.js';
import { getConfig } from './infrastructure/config/app-config.js';
import { errorHandler } from './infrastructure/middleware/error-handler.js';

async function bootstrap(): Promise<void> {
  // Initialize and validate config
  const config = getConfig();

  if (config.x402.enabled) {
    logger.info('x402 payment gateway enabled', {
      x402BaseUrl: config.x402.baseUrl,
      mode: config.getMode(),
      chatCompletions: 'OpenRouter only',
      chatCompletionsUrl: config.x402.chatCompletionsUrl,
      messages: 'All providers',
      messagesUrl: config.x402.messagesUrl,
      module: 'bootstrap'
    });
  }

  await pricingLoader.refreshOpenRouterPricing();
  ensureProvidersConfigured();

  const app = express();
  const PORT = config.server.port;
  // Middleware
  app.set('trust proxy', true);
  app.use(cors());
  app.use(requestContext);
  app.use(requestLogging);
  app.use(express.json({ limit: '50mb' }));

  // Health check
  app.get('/health', (req, res) => {
    logger.debug('Health check accessed', { 
      requestId: req.requestId,
      module: 'health-endpoint'
    });
    
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  });

  // API Routes
  app.post('/v1/chat/completions', handleOpenAIFormatChat);
  app.post('/v1/messages', handleAnthropicFormatChat);
  app.post('/v1/responses', handleOpenAIResponses);
  app.get('/v1/models', handleModelsRequest);
  app.get('/usage', handleUsageRequest);
  app.get('/config/status', handleConfigStatus);
  app.get('/budget', handleGetBudget);
  app.put('/budget', handleUpdateBudget);

  app.get('/keys', handleListKeys);
  app.post('/keys', handleAddKey);
  app.delete('/keys/:id', handleRemoveKey);
  app.put('/keys/:id/priority', handleUpdateKeyPriority);

  // Error handler MUST be last middleware
  app.use(errorHandler);

  // Start server
  app.listen(PORT, () => {
    logger.info('Ekai Gateway server started', {
      port: PORT,
      environment: config.server.environment,
      mode: config.getMode(),
      module: 'server'
    });
  });
}

function ensureProvidersConfigured(): void {
  const config = getConfig();
  const providerService = new ProviderService();
  const availableProviders = providerService.getAvailableProviders();

  // Config validation already ensures we have at least one auth method
  // Just log the mode we're running in
  const mode = config.getMode();
  
  if (mode === 'x402-only') {
    logger.info('Running in x402 payment-only mode (no API keys configured)', {
      mode,
      module: 'bootstrap'
    });
  } else if (mode === 'hybrid') {
    logger.info('Running in hybrid mode (API keys + x402 payments)', {
      mode,
      availableProviders: availableProviders.length,
      module: 'bootstrap'
    });
  } else {
    logger.info('Running in BYOK mode (API keys only, no x402)', {
      mode,
      availableProviders: availableProviders.length,
      module: 'bootstrap'
    });
  }
}

bootstrap().catch(error => {
  logger.error('Gateway failed to start', error, { module: 'bootstrap' });
  process.exit(1);
});
