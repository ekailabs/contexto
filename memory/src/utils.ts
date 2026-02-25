export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

export function gaussianNoise(mean: number, std: number): number {
  const u1 = Math.random() || 1e-6;
  const u2 = Math.random() || 1e-6;
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z0;
}

export const DEFAULT_AGENT = 'default';

/**
 * Normalize a human-friendly agent string to a slug we can safely index on.
 * Falls back to "default" when empty. Throws on invalid input.
 */
export function normalizeAgentId(agent?: string | null): string {
  const trimmed = agent?.trim();
  if (!trimmed) return DEFAULT_AGENT;

  const slug = trimmed.toLowerCase();
  if (!/^[a-z0-9_-]{1,40}$/.test(slug)) {
    throw new Error('invalid_agent');
  }
  return slug;
}
