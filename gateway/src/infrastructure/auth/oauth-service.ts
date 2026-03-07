import { generateCodeVerifier, generateCodeChallenge, generateState } from './pkce.js';
import { saveTokens, getTokens, isTokenExpired, OAuthTokens } from './token-store.js';
import { logger } from '../utils/logger.js';
import { getConfig } from '../config/app-config.js';

interface PendingAuth {
  provider: 'openai' | 'anthropic';
  codeVerifier: string;
  state: string;
  createdAt: number;
}

const pendingAuths = new Map<string, PendingAuth>();

const OPENAI_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const OPENAI_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const ANTHROPIC_AUTH_URL = 'https://claude.ai/oauth/authorize';
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/api/oauth/token';

const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

function getRedirectUri(provider: string): string {
  const config = getConfig();
  const baseUrl = `http://localhost:${config.server.port}`;
  return `${baseUrl}/oauth/${provider}/callback`;
}

export function buildAuthorizationUrl(provider: 'openai' | 'anthropic'): { url: string; state: string } {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  pendingAuths.set(state, {
    provider,
    codeVerifier,
    state,
    createdAt: Date.now(),
  });

  const redirectUri = getRedirectUri(provider);

  let url: string;

  if (provider === 'openai') {
    const config = getConfig();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: config.oauth.openai.clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      scope: 'openai.public',
    });
    url = `${OPENAI_AUTH_URL}?${params.toString()}`;
  } else {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: ANTHROPIC_CLIENT_ID,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      scope: 'user:inference user:profile',
    });
    url = `${ANTHROPIC_AUTH_URL}?${params.toString()}`;
  }

  logger.info('OAuth authorization URL built', { provider, module: 'oauth-service' });
  return { url, state };
}

export async function exchangeCode(state: string, code: string): Promise<OAuthTokens> {
  const pending = pendingAuths.get(state);
  if (!pending) {
    throw new Error('Invalid or expired OAuth state');
  }

  pendingAuths.delete(state);

  if (Date.now() - pending.createdAt > 600000) {
    throw new Error('OAuth session expired');
  }

  const { provider, codeVerifier } = pending;
  const redirectUri = getRedirectUri(provider);

  let tokenUrl: string;
  let body: Record<string, string>;

  if (provider === 'openai') {
    const config = getConfig();
    tokenUrl = OPENAI_TOKEN_URL;
    body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: config.oauth.openai.clientId,
      code_verifier: codeVerifier,
    };
  } else {
    tokenUrl = ANTHROPIC_TOKEN_URL;
    body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: ANTHROPIC_CLIENT_ID,
      code_verifier: codeVerifier,
    };
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Token exchange failed', { provider, status: response.status, error: errorText, module: 'oauth-service' });
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  const data = await response.json() as any;
  const expiresIn = data.expires_in || 28800;

  const tokens: OAuthTokens = {
    provider,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId: data.accountId || data.account?.uuid,
    email: data.account?.email_address,
  };

  saveTokens(provider, tokens);
  logger.info('OAuth tokens exchanged and saved', { provider, module: 'oauth-service' });

  return tokens;
}

export async function refreshAccessToken(provider: 'openai' | 'anthropic'): Promise<OAuthTokens> {
  const existing = getTokens(provider);
  if (!existing) {
    throw new Error(`No OAuth tokens found for ${provider}`);
  }

  let tokenUrl: string;
  let body: Record<string, string>;

  if (provider === 'openai') {
    const config = getConfig();
    tokenUrl = OPENAI_TOKEN_URL;
    body = {
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken,
      client_id: config.oauth.openai.clientId,
    };
  } else {
    tokenUrl = ANTHROPIC_TOKEN_URL;
    body = {
      grant_type: 'refresh_token',
      refresh_token: existing.refreshToken,
      client_id: ANTHROPIC_CLIENT_ID,
    };
  }

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('Token refresh failed', { provider, status: response.status, error: errorText, module: 'oauth-service' });
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  const data = await response.json() as any;
  const expiresIn = data.expires_in || 28800;

  const tokens: OAuthTokens = {
    provider,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || existing.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    accountId: existing.accountId,
    email: existing.email,
  };

  saveTokens(provider, tokens);
  logger.info('OAuth tokens refreshed', { provider, module: 'oauth-service' });

  return tokens;
}

export async function getValidAccessToken(provider: 'openai' | 'anthropic'): Promise<string | undefined> {
  const tokens = getTokens(provider);
  if (!tokens) return undefined;

  if (isTokenExpired(tokens)) {
    try {
      const refreshed = await refreshAccessToken(provider);
      return refreshed.accessToken;
    } catch (error) {
      logger.error('Failed to refresh token, removing stored tokens', error, { provider, module: 'oauth-service' });
      return undefined;
    }
  }

  return tokens.accessToken;
}

export function getOAuthStatus(provider: 'openai' | 'anthropic'): { connected: boolean; email?: string; expiresAt?: number } {
  const tokens = getTokens(provider);
  if (!tokens) return { connected: false };
  return {
    connected: true,
    email: tokens.email,
    expiresAt: tokens.expiresAt,
  };
}
