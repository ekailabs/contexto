import type { ClusterNode, MindmapState, QueryResult, ScoredQueryResult, SearchOptions } from './types.js';
import { cosineSimilarity } from './similarity.js';

function collectAllItems(node: ClusterNode) {
  const result = [...node.items];
  for (const child of node.children) {
    result.push(...collectAllItems(child));
  }
  return result;
}

export function queryMindmap(state: MindmapState, queryEmbedding: number[], maxResults = 10): QueryResult {
  const { root, config } = state;
  const path: string[] = [];
  let current = root;

  // Traverse down the tree following the best-matching branch
  while (current.children.length > 0) {
    let bestChild: ClusterNode | null = null;
    let bestSim = -1;

    for (const child of current.children) {
      const sim = cosineSimilarity(queryEmbedding, child.centroid);
      if (sim > bestSim) {
        bestSim = sim;
        bestChild = child;
      }
    }

    if (!bestChild || bestSim < config.similarityThreshold) {
      break;
    }

    path.push(bestChild.label);
    current = bestChild;
  }

  // Collect all items from the matched branch
  const items = collectAllItems(current);

  // Sort by similarity to query and limit results
  const scored = items.map((item) => ({
    item,
    sim: cosineSimilarity(queryEmbedding, item.embedding),
  }));
  scored.sort((a, b) => b.sim - a.sim);

  return {
    items: scored.slice(0, maxResults).map((s) => s.item),
    path,
  };
}

interface BeamEntry {
  node: ClusterNode;
  path: string[];
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function queryMindmapMultiBranch(
  state: MindmapState,
  queryEmbedding: number[],
  options?: SearchOptions,
): ScoredQueryResult {
  const { root, config } = state;
  const maxResults = options?.maxResults ?? 10;
  const maxTokens = options?.maxTokens;
  const beamWidth = options?.beamWidth ?? 3;

  // Initialize beam with root's children scored above threshold
  let beam: BeamEntry[] = [];
  const terminals: BeamEntry[] = [];

  const rootCandidates = root.children
    .map((child) => ({ child, sim: cosineSimilarity(queryEmbedding, child.centroid) }))
    .filter((c) => c.sim >= config.similarityThreshold)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, beamWidth);

  if (rootCandidates.length === 0) {
    // No children pass threshold — collect from root
    beam = [];
    terminals.push({ node: root, path: [] });
  } else {
    beam = rootCandidates.map((c) => ({ node: c.child, path: [c.child.label] }));
  }

  // Expand beam level by level
  while (beam.length > 0) {
    const nextCandidates: { entry: BeamEntry; sim: number }[] = [];

    for (const entry of beam) {
      if (entry.node.children.length === 0) {
        terminals.push(entry);
        continue;
      }

      const childScores = entry.node.children
        .map((child) => ({ child, sim: cosineSimilarity(queryEmbedding, child.centroid) }))
        .filter((c) => c.sim >= config.similarityThreshold);

      if (childScores.length === 0) {
        // No children pass threshold — this node is terminal
        terminals.push(entry);
      } else {
        for (const cs of childScores) {
          nextCandidates.push({
            entry: { node: cs.child, path: [...entry.path, cs.child.label] },
            sim: cs.sim,
          });
        }
      }
    }

    // Keep top beamWidth candidates for next level
    nextCandidates.sort((a, b) => b.sim - a.sim);
    beam = nextCandidates.slice(0, beamWidth).map((c) => c.entry);
  }

  // Collect and deduplicate items from all terminal nodes
  const seen = new Set<string>();
  const allItems = [];
  for (const terminal of terminals) {
    for (const item of collectAllItems(terminal.node)) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        allItems.push(item);
      }
    }
  }

  // Apply metadata filter if configured
  const filter = options?.filter;
  const filtered = filter
    ? allItems.filter((item) =>
        Object.entries(filter).every(([key, value]) => item.metadata?.[key] === value),
      )
    : allItems;

  const totalCandidates = filtered.length;

  // Score and sort
  const scored = filtered
    .map((item) => ({
      item,
      score: cosineSimilarity(queryEmbedding, item.embedding),
      estimatedTokens: estimateTokens(item.content),
    }))
    .sort((a, b) => b.score - a.score);

  // Apply minScore filter
  const minScore = options?.minScore;
  const thresholded = minScore != null
    ? scored.filter((r) => r.score >= minScore)
    : scored;

  // Apply maxResults
  let results = thresholded.slice(0, maxResults);

  // Apply maxTokens budget
  if (maxTokens != null) {
    let tokenSum = 0;
    const budgeted = [];
    for (const r of results) {
      if (tokenSum + r.estimatedTokens > maxTokens) break;
      tokenSum += r.estimatedTokens;
      budgeted.push(r);
    }
    results = budgeted;
  }

  const totalEstimatedTokens = results.reduce((sum, r) => sum + r.estimatedTokens, 0);
  const paths = terminals.map((t) => t.path);

  return { items: results, paths, totalCandidates, totalEstimatedTokens };
}
