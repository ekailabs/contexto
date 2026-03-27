import type { ConsolidationAction } from './types.js';

/**
 * Consolidation logic for semantic memory.
 * 
 * Determines whether to merge (strengthen), supersede (close old, insert new),
 * or insert a new fact based on existing facts for the same slot (subject + predicate).
 */

interface ExistingFact {
  id: string;
  object: string;
  updatedAt: number;
}

/**
 * Determine consolidation action for a new semantic fact.
 * 
 * @param newFact - The new fact being ingested
 * @param existingActiveFacts - Active facts for the same slot (subject + predicate), sorted by updatedAt desc
 * @returns The action to take: merge, supersede, or insert
 */
export function determineConsolidationAction(
  newFact: { subject: string; predicate: string; object: string },
  existingActiveFacts: ExistingFact[]
): ConsolidationAction {
  // No existing facts for this slot → insert new
  if (existingActiveFacts.length === 0) {
    return { type: 'insert' };
  }

  // Check if exact same object exists → merge (strengthen)
  const exactMatch = existingActiveFacts.find(
    (f) => f.object.toLowerCase() === newFact.object.toLowerCase()
  );
  if (exactMatch) {
    return { type: 'merge', targetId: exactMatch.id };
  }

  // Different object → supersede the most recent active fact
  // existingActiveFacts is sorted by updatedAt desc, so first is most recent
  return { type: 'supersede', targetId: existingActiveFacts[0].id };
}

