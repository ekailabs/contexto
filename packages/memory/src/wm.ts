import type { QueryResult, SectorName } from './types.js';

export const PBWM_GATE_THRESHOLD = 0.5;
export const WM_CAP = 8;

export function filterAndCapWorkingMemory(
  perSector: Record<SectorName, Array<QueryResult & { gateScore?: number }>>,
  cap: number = WM_CAP,
): QueryResult[] {
  const merged = Object.values(perSector).flat();
  const scored = merged
    .map((r) => ({
      ...r,
      gateScore: r.gateScore ?? r.score ?? 0,
    }))
    .filter((r) => r.gateScore > PBWM_GATE_THRESHOLD)
    .sort((a, b) => (b.gateScore ?? 0) - (a.gateScore ?? 0));

  return scored.slice(0, cap);
}
