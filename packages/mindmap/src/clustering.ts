import { agnes } from 'ml-hclust';
import type {
  ConversationItem,
  ClusterNode,
  MindmapConfig,
  MindmapState,
} from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { cosineSimilarity, cosineDistance, averageCentroid, updateCentroid } from './similarity.js';
import { generateLabel } from './labeler.js';

let nextClusterId = 0;
function newClusterId(): string {
  return `cluster-${++nextClusterId}`;
}

// ---------------------------------------------------------------------------
// Collect all leaf items from a tree
// ---------------------------------------------------------------------------

function collectAllItems(node: ClusterNode): ConversationItem[] {
  const result: ConversationItem[] = [...node.items];
  for (const child of node.children) {
    result.push(...collectAllItems(child));
  }
  return result;
}

function countClusters(node: ClusterNode): number {
  let count = node.children.length > 0 || node.items.length > 0 ? 1 : 0;
  for (const child of node.children) {
    count += countClusters(child);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Build mindmap from scratch using ml-hclust agnes()
// ---------------------------------------------------------------------------

interface AgnesCluster {
  index: number;
  children: AgnesCluster[] | null;
  height: number;
  size: number;
  isLeaf: boolean;
}

function dendrogramToTree(
  agnesNode: AgnesCluster,
  items: ConversationItem[],
  config: MindmapConfig,
  depth: number,
): ClusterNode {
  // Leaf node — single item
  if (agnesNode.isLeaf) {
    const item = items[agnesNode.index];
    return {
      id: newClusterId(),
      label: generateLabel([item], item.embedding),
      centroid: [...item.embedding],
      children: [],
      items: [item],
      depth,
      itemCount: 1,
    };
  }

  const children = agnesNode.children ?? [];

  // If this merge happened at a distance above our threshold,
  // the children are separate top-level branches (don't nest further)
  const distanceThreshold = 1 - config.similarityThreshold;

  // Build child nodes recursively
  const childNodes: ClusterNode[] = [];
  for (const child of children) {
    if (child.isLeaf) {
      childNodes.push(dendrogramToTree(child, items, config, depth + 1));
    } else if (child.height <= distanceThreshold || depth + 1 >= config.maxDepth) {
      // Flatten: collect all leaf items under this child into one cluster
      const leafItems = collectLeavesFromAgnes(child, items);
      const centroid = averageCentroid(leafItems.map((i) => i.embedding));
      childNodes.push({
        id: newClusterId(),
        label: generateLabel(leafItems, centroid),
        centroid,
        children: [],
        items: leafItems,
        depth: depth + 1,
        itemCount: leafItems.length,
      });
    } else {
      childNodes.push(dendrogramToTree(child, items, config, depth + 1));
    }
  }

  const allItems = childNodes.flatMap((c) => collectAllItems(c));
  const centroid = averageCentroid(allItems.map((i) => i.embedding));

  return {
    id: newClusterId(),
    label: generateLabel(allItems, centroid),
    centroid,
    children: childNodes,
    items: [],
    depth,
    itemCount: allItems.length,
  };
}

function collectLeavesFromAgnes(
  node: AgnesCluster,
  items: ConversationItem[],
): ConversationItem[] {
  if (node.isLeaf) return [items[node.index]];
  const result: ConversationItem[] = [];
  for (const child of node.children ?? []) {
    result.push(...collectLeavesFromAgnes(child, items));
  }
  return result;
}

function agnesBuild(
  items: ConversationItem[],
  config: MindmapConfig,
): ClusterNode {
  if (items.length === 0) {
    return {
      id: 'root',
      label: 'Knowledge',
      centroid: [],
      children: [],
      items: [],
      depth: 0,
      itemCount: 0,
    };
  }

  if (items.length === 1) {
    return {
      id: 'root',
      label: 'Knowledge',
      centroid: [...items[0].embedding],
      children: [{
        id: newClusterId(),
        label: generateLabel([items[0]], items[0].embedding),
        centroid: [...items[0].embedding],
        children: [],
        items: [items[0]],
        depth: 1,
        itemCount: 1,
      }],
      items: [],
      depth: 0,
      itemCount: 1,
    };
  }

  // Build distance matrix
  const n = items.length;
  const distMatrix: number[][] = [];
  for (let i = 0; i < n; i++) {
    distMatrix[i] = [];
    for (let j = 0; j < n; j++) {
      distMatrix[i][j] = i === j ? 0 : cosineDistance(items[i].embedding, items[j].embedding);
    }
  }

  // Run agnes
  const tree = agnes(distMatrix, {
    method: 'average',
    isDistanceMatrix: true,
  }) as unknown as AgnesCluster;

  const distanceThreshold = 1 - config.similarityThreshold;

  // If the root merge is below threshold, everything is one cluster
  if (tree.height <= distanceThreshold) {
    const centroid = averageCentroid(items.map((i) => i.embedding));
    return {
      id: 'root',
      label: 'Knowledge',
      centroid,
      children: [{
        id: newClusterId(),
        label: generateLabel(items, centroid),
        centroid,
        children: [],
        items,
        depth: 1,
        itemCount: items.length,
      }],
      items: [],
      depth: 0,
      itemCount: items.length,
    };
  }

  // Walk the dendrogram and cut at the threshold to build our tree
  const topChildren: ClusterNode[] = [];
  const rootChildren = tree.children ?? [];

  for (const child of rootChildren) {
    if (child.isLeaf) {
      topChildren.push(dendrogramToTree(child, items, config, 1));
    } else if (child.height > distanceThreshold && 2 < config.maxDepth) {
      // This sub-tree has internal structure worth preserving
      const subNode = dendrogramToTree(child, items, config, 1);
      topChildren.push(subNode);
    } else {
      // Flatten into a single cluster
      const leafItems = collectLeavesFromAgnes(child, items);
      const centroid = averageCentroid(leafItems.map((i) => i.embedding));
      topChildren.push({
        id: newClusterId(),
        label: generateLabel(leafItems, centroid),
        centroid,
        children: [],
        items: leafItems,
        depth: 1,
        itemCount: leafItems.length,
      });
    }
  }

  const allItems = topChildren.flatMap((c) => collectAllItems(c));
  const rootCentroid = averageCentroid(allItems.map((i) => i.embedding));

  return {
    id: 'root',
    label: 'Knowledge',
    centroid: rootCentroid,
    children: topChildren,
    items: [],
    depth: 0,
    itemCount: allItems.length,
  };
}

// ---------------------------------------------------------------------------
// Incremental insert — native tree traversal
// ---------------------------------------------------------------------------

function incrementalInsert(
  root: ClusterNode,
  item: ConversationItem,
  config: MindmapConfig,
): void {
  insertIntoNode(root, item, config);
}

function insertIntoNode(
  node: ClusterNode,
  item: ConversationItem,
  config: MindmapConfig,
): void {
  node.itemCount++;

  // Leaf node or no children — add item here
  if (node.children.length === 0) {
    node.items.push(item);
    node.centroid = updateCentroid(node.centroid, node.itemCount - 1, item.embedding);
    node.label = generateLabel(node.items, node.centroid);
    return;
  }

  // Find best matching child
  let bestChild: ClusterNode | null = null;
  let bestSim = -1;

  for (const child of node.children) {
    const sim = cosineSimilarity(item.embedding, child.centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestChild = child;
    }
  }

  if (bestChild && bestSim >= config.similarityThreshold && bestChild.depth < config.maxDepth) {
    // Descend into best matching child
    insertIntoNode(bestChild, item, config);
  } else {
    // No good match — create new child cluster
    node.children.push({
      id: newClusterId(),
      label: generateLabel([item], item.embedding),
      centroid: [...item.embedding],
      children: [],
      items: [item],
      depth: node.depth + 1,
      itemCount: 1,
    });
  }

  // Update centroid
  node.centroid = updateCentroid(node.centroid, node.itemCount - 1, item.embedding);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildMindmap(
  items: ConversationItem[],
  config?: Partial<MindmapConfig>,
): MindmapState {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const root = agnesBuild(items, cfg);

  return {
    root,
    config: cfg,
    stats: {
      totalItems: items.length,
      totalClusters: countClusters(root),
      insertsSinceRebuild: 0,
    },
  };
}

export function addToMindmap(
  state: MindmapState,
  items: ConversationItem[],
): MindmapState {
  const { config, stats } = state;
  const newTotal = stats.totalItems + items.length;

  // Hybrid decision: rebuild or incremental
  const shouldRebuild =
    newTotal < 100 ||
    stats.insertsSinceRebuild + items.length >= config.rebuildInterval;

  if (shouldRebuild) {
    // Collect all existing items + new items, full rebuild
    const allItems = [...collectAllItems(state.root), ...items];
    const root = agnesBuild(allItems, config);

    return {
      root,
      config,
      stats: {
        totalItems: allItems.length,
        totalClusters: countClusters(root),
        insertsSinceRebuild: 0,
      },
    };
  }

  // Incremental insert
  for (const item of items) {
    incrementalInsert(state.root, item, config);
  }

  return {
    root: state.root,
    config,
    stats: {
      totalItems: newTotal,
      totalClusters: countClusters(state.root),
      insertsSinceRebuild: stats.insertsSinceRebuild + items.length,
    },
  };
}
