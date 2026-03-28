import type { ConversationItem } from './types.js';
import { cosineSimilarity } from './similarity.js';

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about', 'like',
  'through', 'after', 'over', 'between', 'out', 'against', 'during',
  'without', 'before', 'under', 'around', 'among', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
  'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
  'just', 'because', 'if', 'when', 'where', 'how', 'what', 'which',
  'who', 'whom', 'this', 'that', 'these', 'those', 'i', 'me', 'my',
  'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her',
  'it', 'its', 'they', 'them', 'their',
]);

function extractKeyWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

export function generateLabel(items: ConversationItem[], centroid: number[]): string {
  if (items.length === 0) return 'Empty';
  if (items.length === 1) {
    const words = extractKeyWords(items[0].content);
    return words.slice(0, 4).join(' ') || items[0].content.slice(0, 30);
  }

  // Find the item closest to the centroid
  let bestItem = items[0];
  let bestSim = -1;
  for (const item of items) {
    const sim = cosineSimilarity(item.embedding, centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestItem = item;
    }
  }

  // Extract key words from the most representative item
  const representativeWords = extractKeyWords(bestItem.content);
  if (representativeWords.length > 0) {
    return representativeWords.slice(0, 4).join(' ');
  }

  // Fallback: most frequent words across all items
  const freq = new Map<string, number>();
  for (const item of items) {
    for (const word of extractKeyWords(item.content)) {
      freq.set(word, (freq.get(word) ?? 0) + 1);
    }
  }

  const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  return sorted.slice(0, 3).map(([w]) => w).join(' ') || 'Cluster';
}
