// Detect the base host (protocol + hostname) from the runtime environment
const getBaseHost = (): string => {
  if (typeof window === 'undefined') {
    const envUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (envUrl) {
      try { return new URL(envUrl).origin.replace(/:\d+$/, ''); } catch {}
    }
    return 'http://localhost';
  }

  const { protocol, hostname } = window.location;

  // ROFL-style proxy URL pattern
  if (hostname.includes('p3000')) {
    return `${protocol}//${hostname.replace(/p3000.*/, '')}`;
  }

  return `${protocol}//${hostname}`;
};

const buildUrl = (host: string, port: string): string => `${host}:${port}`;

const baseHost = getBaseHost();

export const MEMORY_PORT = process.env.NEXT_PUBLIC_MEMORY_PORT || '4010';

// Embedded mode: UI is served from the same Express server as the API
const isEmbedded =
  process.env.NEXT_PUBLIC_EMBEDDED_MODE === 'true' ||
  (typeof window !== 'undefined' && window.location.port === MEMORY_PORT);

export const API_CONFIG = {
  MEMORY_URL: isEmbedded ? '' : buildUrl(baseHost, MEMORY_PORT),
} as const;
