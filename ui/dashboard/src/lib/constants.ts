export const CHART_COLORS = [
  '#3b82f6', // blue-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#06b6d4', // cyan-500
  '#84cc16', // lime-500
  '#f97316', // orange-500
];

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

export const GATEWAY_PORT = process.env.NEXT_PUBLIC_GATEWAY_PORT || '3001';
export const MEMORY_PORT = process.env.NEXT_PUBLIC_MEMORY_PORT || '4010';

export const API_CONFIG = {
  BASE_URL: buildUrl(baseHost, GATEWAY_PORT),
  MEMORY_URL: buildUrl(baseHost, MEMORY_PORT),
} as const;