import { Request, Response } from 'express';
import {
  buildAuthorizationUrl,
  exchangeCode,
  getOAuthStatus,
} from '../../infrastructure/auth/oauth-service.js';
import { removeTokens } from '../../infrastructure/auth/token-store.js';
import { logger } from '../../infrastructure/utils/logger.js';

export async function handleOAuthAuthorize(req: Request, res: Response): Promise<void> {
  const provider = req.params.provider as 'openai' | 'anthropic';

  if (provider !== 'openai' && provider !== 'anthropic') {
    res.status(400).json({ error: 'Invalid provider. Use "openai" or "anthropic".' });
    return;
  }

  try {
    const { url } = buildAuthorizationUrl(provider);
    res.redirect(url);
  } catch (error) {
    logger.error('OAuth authorization failed', error, { provider, module: 'oauth-handler' });
    res.status(500).json({ error: 'Failed to initiate OAuth flow' });
  }
}

export async function handleOAuthCallback(req: Request, res: Response): Promise<void> {
  const provider = req.params.provider as 'openai' | 'anthropic';
  const { code, state, error } = req.query;

  if (error) {
    res.status(400).json({ error: `OAuth denied: ${error}` });
    return;
  }

  if (!code || !state) {
    res.status(400).json({ error: 'Missing code or state parameter' });
    return;
  }

  try {
    const tokens = await exchangeCode(state as string, code as string);
    res.json({
      status: 'connected',
      provider,
      email: tokens.email,
      message: `Successfully connected to ${provider}. You can now use your subscription for API requests.`,
    });
  } catch (error) {
    logger.error('OAuth callback failed', error, { provider, module: 'oauth-handler' });
    res.status(500).json({ error: 'Failed to complete OAuth flow' });
  }
}

export async function handleOAuthStatus(req: Request, res: Response): Promise<void> {
  const openaiStatus = getOAuthStatus('openai');
  const anthropicStatus = getOAuthStatus('anthropic');

  res.json({
    openai: openaiStatus,
    anthropic: anthropicStatus,
  });
}

export async function handleOAuthDisconnect(req: Request, res: Response): Promise<void> {
  const provider = req.params.provider as 'openai' | 'anthropic';

  if (provider !== 'openai' && provider !== 'anthropic') {
    res.status(400).json({ error: 'Invalid provider. Use "openai" or "anthropic".' });
    return;
  }

  removeTokens(provider);
  res.json({ status: 'disconnected', provider });
}
