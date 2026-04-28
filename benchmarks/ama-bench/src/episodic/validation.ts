// Ported from ekailabs-api-server/src/helpers/summary-validation.ts
// Semantics are identical; only the `episodeData` parameter type has changed
// (now the simpler `TurnData` shape from types.ts).

import type { EpisodeSummary, TurnData, ValidationResult } from './types.js';

const VALID_STATUSES = new Set(['complete', 'partial', 'blocked']);

export function validateSummary(raw: unknown): ValidationResult {
  const failures: string[] = [];
  const obj = raw as Record<string, unknown> | null;

  if (!obj || typeof obj !== 'object') {
    return { valid: false, failures: ['root (not an object)'] };
  }

  // status
  if (!obj.status || !VALID_STATUSES.has(obj.status as string)) {
    failures.push('status');
  }

  // summary
  if (typeof obj.summary !== 'string' || (obj.summary as string).trim() === '') {
    failures.push('summary');
  }

  // key_findings
  if (
    !Array.isArray(obj.key_findings) ||
    obj.key_findings.length === 0 ||
    !obj.key_findings.some((f: unknown) => typeof f === 'string' && f.trim() !== '')
  ) {
    failures.push('key_findings');
  }

  // evidence_refs
  if (!Array.isArray(obj.evidence_refs)) {
    failures.push('evidence_refs');
  }

  // trace_ref is injected after the LLM call, not validated here

  return { valid: failures.length === 0, failures };
}

export function toDegradedSummary(
  raw: unknown,
  failures: string[],
  traceRef: string,
  turn: TurnData,
): EpisodeSummary {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const summary =
    typeof obj.summary === 'string' && (obj.summary as string).trim() ? (obj.summary as string) : '';
  const key_findings = Array.isArray(obj.key_findings)
    ? (obj.key_findings as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];
  const evidence_refs = Array.isArray(obj.evidence_refs)
    ? (obj.evidence_refs as EpisodeSummary['metadata']['evidence_refs'])
    : [];

  console.warn(
    `[episodic] degraded summary — failed fields: ${failures.join(', ')}, traceRef: ${traceRef}`,
  );

  return {
    id: crypto.randomUUID(),
    summary,
    key_findings,
    metadata: {
      status: 'partial',
      evidence_refs,
      open_questions: Array.isArray(obj.open_questions)
        ? (obj.open_questions as string[])
        : undefined,
      confidence: typeof obj.confidence === 'number' ? (obj.confidence as number) : undefined,
      trace_ref: traceRef,
      turn,
    },
    timestamp: new Date().toISOString(),
  };
}
