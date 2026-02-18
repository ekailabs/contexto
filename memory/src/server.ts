import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load env from memory/.env (dist is under memory/dist) then repo root .env
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import express from 'express';
import cors from 'cors';
import { SqliteMemoryStore } from './sqlite-store.js';
import { embed } from './providers/embed.js';
import { extract } from './providers/extract.js';
import { normalizeProfileSlug } from './utils.js';
import type { IngestComponents } from './types.js';
import { ingestDocuments } from './documents.js';

const PORT = Number(process.env.MEMORY_PORT ?? 4005);
const DB_PATH = process.env.MEMORY_DB_PATH ?? './memory.db';

async function main() {
  const app = express();
  const corsOrigins =
    process.env.MEMORY_CORS_ORIGIN?.split(',').map((s) => s.trim()).filter(Boolean) ?? '*';
  app.use(
    cors({
      origin: corsOrigins,
    }),
  );
  app.options('*', cors({ origin: corsOrigins }));
  app.use(express.json({ limit: '2mb' }));

  const store = new SqliteMemoryStore({
    dbPath: DB_PATH,
    embed,
  });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.get('/v1/profiles', (_req, res) => {
    try {
      const profiles = store.getAvailableProfiles();
      res.json({ profiles });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'failed to fetch profiles' });
    }
  });

  const handleDeleteProfile: express.RequestHandler = (req, res) => {
    try {
      const { slug } = req.params;
      const normalizedProfile = normalizeProfileSlug(slug);
      const deleted = store.deleteProfile(normalizedProfile);
      res.json({ deleted, profile: normalizedProfile });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      if (err?.message === 'cannot_delete_default_profile') {
        return res.status(400).json({ error: 'default_profile_protected' });
      }
      res.status(500).json({ error: err.message ?? 'delete profile failed' });
    }
  };
  app.delete('/v1/profiles/:slug', handleDeleteProfile);

  app.post('/v1/ingest', async (req, res) => {
    const { messages, profile, userId } = req.body as {
      messages?: Array<{ role: 'user' | 'assistant' | string; content: string }>;
      profile?: string;
      userId?: string;
    };

    let normalizedProfile: string;
    try {
      normalizedProfile = normalizeProfileSlug(profile);
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      return res.status(500).json({ error: 'profile_normalization_failed' });
    }

    if (!messages || !messages.length) {
      return res.status(400).json({ error: 'messages is required and must include at least one item' });
    }
    const userMessages = messages.filter((m) => m.role === 'user' && m.content?.trim());
    if (!userMessages.length) {
      return res.status(400).json({ error: 'at least one user message with content is required' });
    }

    // Pass full conversation (user + assistant) to extraction for agent-centric reflection
    const allMessages = messages.filter((m) => m.content?.trim());
    const sourceText = allMessages
      .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.trim()}`)
      .join('\n\n');

    let finalComponents: IngestComponents | undefined;

    try {
      finalComponents = await extract(sourceText);
    } catch (err: any) {
      return res.status(500).json({ error: err.message ?? 'extraction failed' });
    }

    if (!finalComponents) {
      return res.status(400).json({ error: 'unable to extract components from messages' });
    }
    try {
      const rows = await store.ingest(finalComponents, normalizedProfile, {
        origin: { originType: 'conversation', originActor: userId },
        userId,
      });
      res.json({ stored: rows.length, ids: rows.map((r) => r.id), profile: normalizedProfile });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'ingest failed' });
    }
  });

  app.post('/v1/ingest/documents', async (req, res) => {
    const { path: docPath, profile } = req.body as {
      path?: string;
      profile?: string;
    };

    if (!docPath || !docPath.trim()) {
      return res.status(400).json({ error: 'path_required' });
    }

    let normalizedProfile: string;
    try {
      normalizedProfile = normalizeProfileSlug(profile);
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      return res.status(500).json({ error: 'profile_normalization_failed' });
    }

    // Validate path exists
    try {
      const fs = await import('node:fs/promises');
      await fs.stat(docPath.trim());
    } catch {
      return res.status(400).json({ error: 'path_not_found' });
    }

    try {
      const result = await ingestDocuments(docPath.trim(), store, normalizedProfile);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'document ingestion failed' });
    }
  });

  app.get('/v1/summary', (req, res) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const profile = req.query.profile as string;
      const normalizedProfile = normalizeProfileSlug(profile);
      const summary = store.getSectorSummary(normalizedProfile);
      const recent = store.getRecent(normalizedProfile, limit).map((r) => ({
        id: r.id,
        sector: r.sector,
        profile: r.profileId,
        createdAt: r.createdAt,
        lastAccessed: r.lastAccessed,
        preview: r.content,
        retrievalCount: (r as any).retrievalCount ?? 0,
        details: (r as any).details,
      }));
      res.json({ summary, recent, profile: normalizedProfile });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'summary failed' });
    }
  });

  app.put('/v1/memory/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { content, sector, profile } = req.body as { content?: string; sector?: string; profile?: string };

      if (!id) return res.status(400).json({ error: 'id_required' });
      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'content_required' });
      }

      let normalizedProfile: string;
      try {
        normalizedProfile = normalizeProfileSlug(profile);
      } catch (err: any) {
        if (err?.message === 'invalid_profile') {
          return res.status(400).json({ error: 'invalid_profile' });
        }
        return res.status(500).json({ error: 'profile_normalization_failed' });
      }

      const updated = await store.updateById(id, content.trim(), sector as any, normalizedProfile);
      if (!updated) {
        return res.status(404).json({ error: 'not_found', id });
      }
      res.json({ updated: true, id, profile: normalizedProfile });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'update failed' });
    }
  });

  app.delete('/v1/memory/:id', (req, res) => {
    try {
      const { id } = req.params;
      const profile = req.query.profile as string;
      if (!id) return res.status(400).json({ error: 'id_required' });
      let normalizedProfile: string;
      try {
        normalizedProfile = normalizeProfileSlug(profile);
      } catch (err: any) {
        if (err?.message === 'invalid_profile') {
          return res.status(400).json({ error: 'invalid_profile' });
        }
        return res.status(500).json({ error: 'profile_normalization_failed' });
      }
      const deleted = store.deleteById(id, normalizedProfile);
      if (!deleted) {
        return res.status(404).json({ error: 'not_found', id });
      }
      res.json({ deleted, profile: normalizedProfile });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'delete failed' });
    }
  });

  app.delete('/v1/memory', (req, res) => {
    try {
      const profile = req.query.profile as string;
      const normalizedProfile = normalizeProfileSlug(profile);
      const deleted = store.deleteAll(normalizedProfile);
      res.json({ deleted, profile: normalizedProfile });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'delete all failed' });
    }
  });

  // Delete a single semantic graph triple by id
  app.delete('/v1/graph/triple/:id', (req, res) => {
    try {
      const { id } = req.params;
      const profile = req.query.profile as string;
      if (!id) return res.status(400).json({ error: 'id_required' });

      const deleted = store.deleteSemanticById(id, profile);
      if (!deleted) {
        return res.status(404).json({ error: 'not_found', id });
      }

      res.json({ deleted });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'triple delete failed' });
    }
  });

  app.post('/v1/search', async (req, res) => {
    const { query, profile, userId } = req.body as { query?: string; profile?: string; userId?: string };
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    try {
      const result = await store.query(query, profile, userId);
      res.json(result);
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'query failed' });
    }
  });

  // --- Agent Users ---

  app.get('/v1/users', (req, res) => {
    try {
      const profile = req.query.profile as string;
      const normalizedProfile = normalizeProfileSlug(profile);
      const users = store.getAgentUsers(normalizedProfile);
      res.json({ users, profile: normalizedProfile });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'failed to fetch users' });
    }
  });

  app.get('/v1/users/:id/memories', (req, res) => {
    try {
      const { id: userId } = req.params;
      const profile = req.query.profile as string;
      const limit = Number(req.query.limit) || 50;
      const normalizedProfile = normalizeProfileSlug(profile);

      if (!userId) {
        return res.status(400).json({ error: 'user_id_required' });
      }

      const memories = store.getMemoriesForUser(normalizedProfile, userId, limit).map((r) => ({
        id: r.id,
        sector: r.sector,
        profile: r.profileId,
        createdAt: r.createdAt,
        lastAccessed: r.lastAccessed,
        preview: r.content,
        details: (r as any).details,
      }));
      res.json({ memories, userId, profile: normalizedProfile });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'failed to fetch user memories' });
    }
  });

  // Graph traversal endpoints
  app.get('/v1/graph/triples', (req, res) => {
    try {
      const { entity, direction, maxResults, predicate, profile } = req.query;
      if (!entity || typeof entity !== 'string') {
        return res.status(400).json({ error: 'entity query parameter is required' });
      }

      const options: any = {
        maxResults: maxResults ? Number(maxResults) : 100,
        predicateFilter: predicate as string | undefined,
        profile: profile as string,
      };

      let triples;
      if (direction === 'incoming' || direction === 'in') {
        triples = store.graph.findTriplesByObject(entity, options);
      } else if (direction === 'outgoing' || direction === 'out') {
        triples = store.graph.findTriplesBySubject(entity, options);
      } else {
        triples = store.graph.findConnectedTriples(entity, options);
      }

      res.json({ entity, triples, count: triples.length });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'graph query failed' });
    }
  });

  app.get('/v1/graph/neighbors', (req, res) => {
    try {
      const { entity, profile } = req.query;
      if (!entity || typeof entity !== 'string') {
        return res.status(400).json({ error: 'entity query parameter is required' });
      }

      const neighbors = Array.from(store.graph.findNeighbors(entity, { profile: profile as string }));
      res.json({ entity, neighbors, count: neighbors.length });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'neighbors query failed' });
    }
  });

  app.get('/v1/graph/paths', (req, res) => {
    try {
      const { from, to, maxDepth, profile } = req.query;
      if (!from || typeof from !== 'string' || !to || typeof to !== 'string') {
        return res.status(400).json({ error: 'from and to query parameters are required' });
      }

      const paths = store.graph.findPaths(from, to, {
        maxDepth: maxDepth ? Number(maxDepth) : 3,
        profile: profile as string,
      });

      res.json({ from, to, paths, count: paths.length });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'paths query failed' });
    }
  });

  app.get('/v1/graph/visualization', (req, res) => {
    try {
      const { entity, maxDepth, maxNodes, profile, includeHistory } = req.query;
      const profileValue = profile as string;
      const normalizedProfile = normalizeProfileSlug(profileValue);
      const centerEntity = (entity as string) || null;
      const depth = maxDepth ? Number(maxDepth) : 2;
      const nodeLimit = maxNodes ? Number(maxNodes) : 50;
      const showHistory = includeHistory === 'true' || includeHistory === '1';

      // If no center entity, get a sample of semantic triples
      if (!centerEntity) {
        const allSemantic = store.getRecent(normalizedProfile, 100).filter((r) => r.sector === 'semantic');
        const triples = allSemantic
          .slice(0, nodeLimit)
          .map((r) => (r as any).details)
          .filter((d) => d && d.subject && d.predicate && d.object)
          .filter((d) => showHistory || !d.validTo); // Filter out historical if not requested

        const nodes = new Set<string>();
        const edges: Array<{ source: string; target: string; predicate: string; isHistorical?: boolean }> = [];

        for (const triple of triples) {
          nodes.add(triple.subject);
          nodes.add(triple.object);
          edges.push({
            source: triple.subject,
            target: triple.object,
            predicate: triple.predicate,
            isHistorical: triple.validTo != null,
          });
        }

        return res.json({
          nodes: Array.from(nodes).map((id) => ({ id, label: id })),
          edges,
          includeHistory: showHistory,
          profile: normalizedProfile,
        });
      }

      // Build graph from center entity
      const graphOptions = { maxDepth: depth, profile: normalizedProfile, includeInvalidated: showHistory };
      const reachable = store.graph.findReachableEntities(centerEntity, graphOptions);
      const nodes = new Set<string>([centerEntity]);
      const edges: Array<{ source: string; target: string; predicate: string; isHistorical?: boolean }> = [];

      // Add center entity's connections
      const centerTriples = store.graph.findConnectedTriples(centerEntity, { maxResults: 100, profile: normalizedProfile, includeInvalidated: showHistory });
      for (const triple of centerTriples) {
        nodes.add(triple.subject);
        nodes.add(triple.object);
        edges.push({
          source: triple.subject,
          target: triple.object,
          predicate: triple.predicate,
          isHistorical: triple.validTo != null,
        });
      }

      // Add connections for reachable entities (up to node limit)
      const reachableArray = Array.from(reachable.entries())
        .sort((a, b) => a[1] - b[1])
        .slice(0, nodeLimit - nodes.size);

      for (const [entity, _depth] of reachableArray) {
        const entityTriples = store.graph.findTriplesBySubject(entity, { maxResults: 10, profile: normalizedProfile, includeInvalidated: showHistory });
        for (const triple of entityTriples) {
          if (nodes.has(triple.subject) || nodes.has(triple.object)) {
            nodes.add(triple.subject);
            nodes.add(triple.object);
            edges.push({
              source: triple.subject,
              target: triple.object,
              predicate: triple.predicate,
              isHistorical: triple.validTo != null,
            });
          }
        }
      }

      res.json({
        center: centerEntity,
        nodes: Array.from(nodes).map((id) => ({ id, label: id })),
        edges,
        includeHistory: showHistory,
        profile: normalizedProfile,
      });
    } catch (err: any) {
      if (err?.message === 'invalid_profile') {
        return res.status(400).json({ error: 'invalid_profile' });
      }
      res.status(500).json({ error: err.message ?? 'visualization query failed' });
    }
  });

  // Fallback 404 with CORS headers
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Memory service listening on :${PORT}, db at ${DB_PATH}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
