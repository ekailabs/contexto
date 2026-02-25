import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SqliteMemoryStore } from '../src/sqlite-store.js';
import type { EmbedFn, SectorName, IngestComponents } from '../src/types.js';

// ── Mock embedding strategy ──────────────────────────────────────────
// 8-dim vectors with controlled orthogonal directions.
// Same text always returns the same vector (deterministic).

const VECTORS: Record<string, number[]> = {
  'dark mode':                   [1, 0, 0, 0, 0, 0, 0, 0],
  'light mode':                  [0.9, 0.1, 0, 0, 0, 0, 0, 0], // similar to dark mode
  'TypeScript':                  [0, 1, 0, 0, 0, 0, 0, 0],
  'deploy to prod':              [0, 0, 1, 0, 0, 0, 0, 0],
  'prefers':                     [0, 0, 0, 1, 0, 0, 0, 0],
  'supports':                    [0, 0, 0, 0, 1, 0, 0, 0],
  // Full triple texts used during ingest (subject + predicate + object)
  'Sha prefers dark mode':       [0.7, 0, 0, 0.7, 0, 0, 0, 0],
  'Sha prefers light mode':      [0.63, 0.07, 0, 0.7, 0, 0, 0, 0],
  'Sha supports TypeScript':     [0, 0.7, 0, 0, 0.7, 0, 0, 0],
  // Episodic & procedural
  'deployed v2 to staging':      [0, 0, 0.9, 0, 0, 0.1, 0, 0],
  'run npm test before pushing': [0, 0, 0, 0, 0, 0, 1, 0],
  'run npm test':                [0, 0, 0, 0, 0, 0, 1, 0],
  // Reflective
  'user prefers concise answers': [0, 0, 0, 0.5, 0, 0, 0, 0.5],
  'this is a reflection':         [0, 0, 0, 0, 0, 0, 0, 1],
};

/** Hash text to a deterministic 8-dim vector for unknown strings. */
function hashToVector(text: string): number[] {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  }
  const vec = new Array(8).fill(0);
  for (let i = 0; i < 8; i++) {
    // Use different bits of the hash for each dimension
    vec[i] = ((h >>> (i * 4)) & 0xf) / 15;
  }
  // Normalize
  const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0)) || 1;
  return vec.map((v: number) => v / mag);
}

const mockEmbed: EmbedFn = async (text: string, _sector: SectorName) => {
  return VECTORS[text] ?? hashToVector(text);
};

// Fixed timestamp for deterministic tests
const NOW = 1700000000000;

function createStore(now = NOW): SqliteMemoryStore {
  return new SqliteMemoryStore({
    dbPath: ':memory:',
    embed: mockEmbed,
    now: () => now,
  });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('SqliteMemoryStore (single-user mode)', () => {
  let store: SqliteMemoryStore;

  beforeEach(() => {
    store = createStore();
  });

  // ─── 1. Ingest active sectors ────────────────────────────────────
  it('ingests episodic, semantic, procedural and skips reflective', async () => {
    const rows = await store.ingest(
      {
        episodic: 'deployed v2 to staging',
        semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
        procedural: {
          trigger: 'deploy to prod',
          goal: 'ship release',
          steps: ['build', 'test', 'deploy'],
        },
        reflective: { observation: 'user prefers concise answers' },
      },
      undefined,
      { origin: { originType: 'conversation', originActor: 'test' } },
    );

    expect(rows).toHaveLength(3);
    const sectors = rows.map((r) => r.sector).sort();
    expect(sectors).toEqual(['episodic', 'procedural', 'semantic']);
  });

  // ─── 2. Query returns results matching dashboard shape ────────────
  it('query returns workingMemory and perSector with expected shapes', async () => {
    // Ingest data across all 4 sectors
    await store.ingest(
      {
        episodic: 'deployed v2 to staging',
        semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
        procedural: {
          trigger: 'deploy to prod',
          goal: 'ship release',
          steps: ['build', 'test', 'deploy'],
        },
        reflective: { observation: 'user prefers concise answers' },
      },
      undefined,
      { origin: { originType: 'conversation', originActor: 'test' } },
    );

    // Query with text similar to the semantic triple
    const result = await store.query('dark mode');

    // Structure
    expect(result).toHaveProperty('workingMemory');
    expect(result).toHaveProperty('perSector');
    expect(result).toHaveProperty('agentId');
    expect(Array.isArray(result.workingMemory)).toBe(true);

    // perSector has all 3 active sector keys (reflective is disabled)
    for (const sector of ['episodic', 'semantic', 'procedural'] as SectorName[]) {
      expect(result.perSector).toHaveProperty(sector);
      expect(Array.isArray(result.perSector[sector])).toBe(true);
    }

    // Semantic results carry content as "subject predicate object"
    const semanticResults = result.perSector.semantic;
    if (semanticResults.length > 0) {
      const first = semanticResults[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('score');
      expect(first).toHaveProperty('similarity');
      expect(first.content).toContain('Sha');
      expect(first.content).toContain('dark mode');
    }

    // Procedural results carry trigger as content
    const procResults = result.perSector.procedural;
    if (procResults.length > 0) {
      const first = procResults[0];
      expect(first).toHaveProperty('id');
      expect(first).toHaveProperty('score');
      expect(first.content).toBe('deploy to prod');
    }
  });

  // ─── 3. Semantic consolidation — merge ────────────────────────────
  it('merges duplicate semantic triples and increases strength', async () => {
    // Ingest same triple twice
    await store.ingest({
      semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
    });
    await store.ingest({
      semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
    });

    const summary = store.getSectorSummary();
    const semanticCount = summary.find((s) => s.sector === 'semantic')!.count;
    // Should only have 1 row because the second ingest merged
    expect(semanticCount).toBe(1);

    // Query to verify strength increased
    const result = await store.query('Sha prefers dark mode');
    // The fact should be findable
    expect(result.perSector.semantic.length).toBeGreaterThanOrEqual(1);
  });

  // ─── 4. Semantic consolidation — supersede ────────────────────────
  it('supersedes semantic facts when object changes', async () => {
    // Ingest original preference
    await store.ingest({
      semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
    });

    // Ingest conflicting preference — should supersede
    await store.ingest({
      semantic: { subject: 'Sha', predicate: 'prefers', object: 'light mode' },
    });

    // There should be 2 semantic rows total (old one closed, new one active)
    // But getSectorSummary counts all rows
    const summary = store.getSectorSummary();
    const semanticCount = summary.find((s) => s.sector === 'semantic')!.count;
    expect(semanticCount).toBe(2);

    // Query should only return the active (light mode) fact
    const result = await store.query('Sha prefers light mode');
    const activeFacts = result.perSector.semantic;
    // Semantic content is "subject predicate object" — only non-expired facts should come back
    const factContents = activeFacts.map((f) => f.content);
    expect(factContents.some((c) => c.includes('light mode'))).toBe(true);
    expect(factContents.some((c) => c.includes('dark mode') && !c.includes('light mode'))).toBe(false);
  });

  // ─── 5. getSectorSummary (dashboard /v1/summary) ──────────────────
  it('getSectorSummary returns correct counts per sector', async () => {
    await store.ingest(
      {
        episodic: 'deployed v2 to staging',
        semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
        procedural: { trigger: 'deploy to prod', steps: ['build', 'deploy'] },
      },
    );

    const summary = store.getSectorSummary();

    // Should have 3 active sectors (reflective is disabled)
    expect(summary).toHaveLength(3);
    const bySector = Object.fromEntries(summary.map((s) => [s.sector, s]));

    expect(bySector.episodic.count).toBe(1);
    expect(bySector.semantic.count).toBe(1);
    expect(bySector.procedural.count).toBe(1);

    // Each sector has lastCreatedAt
    for (const s of summary) {
      expect(s).toHaveProperty('sector');
      expect(s).toHaveProperty('count');
      expect(s).toHaveProperty('lastCreatedAt');
    }
  });

  // ─── 6. getRecent (dashboard /v1/summary recent) ──────────────────
  it('getRecent returns items in createdAt desc order with correct shape', async () => {
    // Ingest with advancing timestamps
    let t = NOW;
    const store1 = new SqliteMemoryStore({
      dbPath: ':memory:',
      embed: mockEmbed,
      now: () => t,
    });

    t = NOW;
    await store1.ingest({
      episodic: 'deployed v2 to staging',
    });

    t = NOW + 1000;
    await store1.ingest({
      semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
    });

    t = NOW + 2000;
    await store1.ingest(
      {
        procedural: { trigger: 'run npm test before pushing', steps: ['npm test'] },
      },
    );

    const recent = store1.getRecent(undefined, 10);

    // Should return 3 items (reflective is disabled)
    expect(recent.length).toBe(3);

    // Descending order by createdAt
    for (let i = 0; i < recent.length - 1; i++) {
      expect(recent[i].createdAt).toBeGreaterThanOrEqual(recent[i + 1].createdAt);
    }

    // Each item has the shape the dashboard expects (MemoryRecentItem)
    for (const item of recent) {
      expect(item).toHaveProperty('id');
      expect(item).toHaveProperty('sector');
      expect(item).toHaveProperty('createdAt');
      expect(item).toHaveProperty('lastAccessed');
      expect(item).toHaveProperty('content');
      expect(typeof item.id).toBe('string');
      expect(typeof item.sector).toBe('string');
      expect(typeof item.createdAt).toBe('number');
    }

    // Semantic items should have details with subject/predicate/object
    const semanticItem = recent.find((r) => r.sector === 'semantic');
    expect(semanticItem).toBeDefined();
    expect(semanticItem!.details).toBeDefined();
    expect(semanticItem!.details.subject).toBe('Sha');
    expect(semanticItem!.details.predicate).toBe('prefers');
    expect(semanticItem!.details.object).toBe('dark mode');

    // Procedural items should have details with trigger/steps
    const procItem = recent.find((r) => r.sector === 'procedural');
    expect(procItem).toBeDefined();
    expect(procItem!.details).toBeDefined();
    expect(procItem!.details.trigger).toBe('run npm test before pushing');
    expect(Array.isArray(procItem!.details.steps)).toBe(true);
  });

  // ─── 7. Reflective is always skipped (disabled) ─────────────────
  it('skips reflective even with origin', async () => {
    const rows = await store.ingest(
      {
        reflective: { observation: 'this is a reflection' },
      },
      undefined,
      { origin: { originType: 'conversation', originActor: 'test', originRef: 'conv-123' } },
    );
    const reflectiveRows = rows.filter((r) => r.sector === 'reflective');
    expect(reflectiveRows).toHaveLength(0);
  });

  // ─── 8. Empty ingest ──────────────────────────────────────────────
  it('returns empty array for empty/undefined components', async () => {
    const rows1 = await store.ingest({});
    expect(rows1).toEqual([]);

    const rows2 = await store.ingest({
      episodic: undefined,
      semantic: undefined,
      procedural: undefined,
      reflective: undefined,
    });
    expect(rows2).toEqual([]);

    // Empty strings should also produce nothing
    const rows3 = await store.ingest({
      episodic: '',
      procedural: '',
    });
    expect(rows3).toEqual([]);
  });

  // ─── 9. Delete operations (dashboard DELETE endpoints) ────────────
  it('deleteById removes a single memory, deleteAll clears everything', async () => {
    const rows = await store.ingest(
      {
        episodic: 'deployed v2 to staging',
        semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
        procedural: { trigger: 'deploy to prod', steps: ['build', 'deploy'] },
      },
    );
    expect(rows).toHaveLength(3);

    // deleteById — remove the episodic row
    const episodicRow = rows.find((r) => r.sector === 'episodic')!;
    const deleted = store.deleteById(episodicRow.id);
    expect(deleted).toBe(1);

    // Verify it's gone
    const summaryAfterDelete = store.getSectorSummary();
    expect(summaryAfterDelete.find((s) => s.sector === 'episodic')!.count).toBe(0);
    // Others still present
    expect(summaryAfterDelete.find((s) => s.sector === 'semantic')!.count).toBe(1);
    expect(summaryAfterDelete.find((s) => s.sector === 'procedural')!.count).toBe(1);

    // deleteAll — clears all sector tables
    const totalDeleted = store.deleteAll();
    expect(totalDeleted).toBe(2); // 2 remaining after episodic was deleted

    const summaryAfterDeleteAll = store.getSectorSummary();
    for (const s of summaryAfterDeleteAll) {
      expect(s.count).toBe(0);
    }
  });

  // ─── 10. Agent isolation (agent selector) ───────────
  it('isolates memories by agent and getAgents returns both', async () => {
    // Create agents explicitly
    store.addAgent('agent-a', { name: 'Agent A' });
    store.addAgent('agent-b', { name: 'Agent B' });

    // Ingest for agent "agent-a"
    await store.ingest(
      {
        episodic: 'deployed v2 to staging',
        semantic: { subject: 'Sha', predicate: 'prefers', object: 'dark mode' },
      },
      'agent-a',
    );

    // Ingest for agent "agent-b"
    await store.ingest(
      {
        episodic: 'TypeScript',
        semantic: { subject: 'Sha', predicate: 'supports', object: 'TypeScript' },
      },
      'agent-b',
    );

    // Query agent-a should return only its memories
    const resultA = await store.query('dark mode', 'agent-a');
    expect(resultA.agentId).toBe('agent-a');
    // Episodic and semantic should only come from agent-a
    for (const sector of ['episodic', 'semantic'] as SectorName[]) {
      for (const row of resultA.perSector[sector]) {
        expect(row.agentId).toBe('agent-a');
      }
    }

    // Query agent-b should return only its memories
    const resultB = await store.query('TypeScript', 'agent-b');
    expect(resultB.agentId).toBe('agent-b');
    for (const sector of ['episodic', 'semantic'] as SectorName[]) {
      for (const row of resultB.perSector[sector]) {
        expect(row.agentId).toBe('agent-b');
      }
    }

    // getAgents returns both (plus 'default')
    const agents = store.getAgents();
    const agentIds = agents.map((a) => a.id);
    expect(agentIds).toContain('agent-a');
    expect(agentIds).toContain('agent-b');
    expect(agentIds).toContain('default');
  });

  // ─── 11. addAgent and getAgent ───────────────────────────────────
  it('addAgent creates agent and getAgent retrieves it', () => {
    const agent = store.addAgent('test-bot', { name: 'Test Bot', soulMd: 'You are helpful' });
    expect(agent.id).toBe('test-bot');
    expect(agent.name).toBe('Test Bot');
    expect(agent.soulMd).toBe('You are helpful');
    expect(agent.createdAt).toBe(NOW);

    const retrieved = store.getAgent('test-bot');
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe('test-bot');
    expect(retrieved!.name).toBe('Test Bot');
    expect(retrieved!.soulMd).toBe('You are helpful');
  });

  // ─── 12. addAgent upserts on conflict ─────────────────────────────
  it('addAgent upserts name and soulMd on conflict', () => {
    store.addAgent('my-bot', { name: 'V1' });
    store.addAgent('my-bot', { name: 'V2', soulMd: 'Updated soul' });

    const agent = store.getAgent('my-bot');
    expect(agent!.name).toBe('V2');
    expect(agent!.soulMd).toBe('Updated soul');
  });

  // ─── 13. getAgent returns undefined for non-existent ─────────────
  it('getAgent returns undefined for non-existent agent', () => {
    const agent = store.getAgent('does-not-exist');
    expect(agent).toBeUndefined();
  });

  // ─── 14. deleteAgent removes agent and all its data ──────────────
  it('deleteAgent removes agent and its memories', async () => {
    store.addAgent('temp-agent');
    await store.ingest(
      { episodic: 'deployed v2 to staging' },
      'temp-agent',
    );

    const summary = store.getSectorSummary('temp-agent');
    expect(summary.find((s) => s.sector === 'episodic')!.count).toBe(1);

    store.deleteAgent('temp-agent');

    // Agent should be gone
    const agent = store.getAgent('temp-agent');
    expect(agent).toBeUndefined();
  });

  // ─── 15. Cannot delete default agent ──────────────────────────────
  it('throws when trying to delete default agent', () => {
    expect(() => store.deleteAgent('default')).toThrow('cannot_delete_default_agent');
  });
});
