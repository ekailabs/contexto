import type { ClusterNode, MindmapState, QueryResult } from './types.js';
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
