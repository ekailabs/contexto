import type { MemoryRecord, QueryResult, SectorName } from './types.js';
import { gaussianNoise, sigmoid } from './utils.js';

const DEFAULT_SECTOR_WEIGHTS: Record<SectorName, number> = {
  episodic: 1,
  semantic: 1,
  procedural: 1,

};
const RETRIEVAL_SOFTCAP = 10; // for normalization
const RELEVANCE_WEIGHT = 1.0;
const EXPECTED_VALUE_WEIGHT = 0.4;
const CONTROL_WEIGHT = 0.05;
const NOISE_WEIGHT = 0.02;
const CONTROL_SIGNAL = 0.3;

/**
 * Minimal PBWM-inspired gate.
 * expected_value uses retrieval_count; control fixed for now; noise is small Gaussian.
 * Returns QueryResult plus gateScore for downstream gating.
 */
export function scoreRowPBWM(
  row: MemoryRecord & { similarity: number },
  sectorWeight: number = DEFAULT_SECTOR_WEIGHTS[row.sector],
): QueryResult & { gateScore: number } {
  const relevance = row.similarity;

  const expectedValue = normalizeRetrieval(row);
  const noise = gaussianNoise(0, 0.05);

  const x =
    RELEVANCE_WEIGHT * relevance +
    EXPECTED_VALUE_WEIGHT * expectedValue +
    CONTROL_WEIGHT * CONTROL_SIGNAL -
    NOISE_WEIGHT * noise;

  const gateScore = sigmoid(x);
  const score = gateScore * sectorWeight;

  return {
    sector: row.sector,
    id: row.id,
    agentId: row.agentId,
    content: row.content,
    score,
    similarity: relevance,
    decay: 1,
    createdAt: row.createdAt,
    lastAccessed: row.lastAccessed,
    gateScore,
  };
}

export const PBWM_SECTOR_WEIGHTS = DEFAULT_SECTOR_WEIGHTS;

function normalizeRetrieval(row: MemoryRecord): number {
  const count = (row as any).retrievalCount ?? 0;
  const retrievalScore = count > 0 ? Math.log(1 + count) / Math.log(1 + RETRIEVAL_SOFTCAP) : 0;
  return Math.min(1, retrievalScore);
}
