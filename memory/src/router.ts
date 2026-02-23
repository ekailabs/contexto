import { Router } from 'express';
import type { Request, Response } from 'express';
import type { SqliteMemoryStore } from './sqlite-store.js';
import type { ExtractFn } from './types.js';
import { extract as defaultExtract } from './providers/extract.js';
import { normalizeAgentId } from './utils.js';
import type { IngestComponents } from './types.js';


/**
 * Creates an Express Router with all memory API routes.
 * The store is received via closure — no global state needed.
 */
export function createMemoryRouter(store: SqliteMemoryStore, extractFn?: ExtractFn): Router {
  const router = Router();
  const doExtract = extractFn ?? defaultExtract;

  router.get('/v1/agents', (_req: Request, res: Response) => {
    try {
      const agents = store.getAgents();
      res.json({ agents });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'failed to fetch agents' });
    }
  });

  const handleDeleteAgent = (req: Request, res: Response) => {
    try {
      const { slug } = req.params;
      const normalizedAgent = normalizeAgentId(slug);
      const deleted = store.deleteAgent(normalizedAgent);
      res.json({ deleted, agent: normalizedAgent });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      if (err?.message === 'cannot_delete_default_agent') {
        return res.status(400).json({ error: 'default_agent_protected' });
      }
      res.status(500).json({ error: err.message ?? 'delete agent failed' });
    }
  };
  router.delete('/v1/agents/:slug', handleDeleteAgent);

  router.post('/v1/ingest', async (req: Request, res: Response) => {
    const { messages, agent, userId } = req.body as {
      messages?: Array<{ role: 'user' | 'assistant' | string; content: string }>;
      agent?: string;
      userId?: string;
    };

    let normalizedAgent: string;
    try {
      normalizedAgent = normalizeAgentId(agent);
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      return res.status(500).json({ error: 'agent_normalization_failed' });
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
      finalComponents = await doExtract(sourceText);
    } catch (err: any) {
      return res.status(500).json({ error: err.message ?? 'extraction failed' });
    }

    if (!finalComponents) {
      return res.status(400).json({ error: 'unable to extract components from messages' });
    }
    try {
      const rows = await store.ingest(finalComponents, normalizedAgent, {
        origin: { originType: 'conversation', originActor: userId },
        userId,
      });
      res.json({ stored: rows.length, ids: rows.map((r) => r.id), agent: normalizedAgent });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'ingest failed' });
    }
  });

  router.get('/v1/summary', (req: Request, res: Response) => {
    try {
      const limit = Number(req.query.limit) || 50;
      const agent = req.query.agent as string;
      const normalizedAgent = normalizeAgentId(agent);
      const summary = store.getSectorSummary(normalizedAgent);
      const recent = store.getRecent(normalizedAgent, limit).map((r) => ({
        id: r.id,
        sector: r.sector,
        agent: r.agentId,
        createdAt: r.createdAt,
        lastAccessed: r.lastAccessed,
        preview: r.content,
        retrievalCount: (r as any).retrievalCount ?? 0,
        details: (r as any).details,
        userScope: (r as any).userScope ?? null,
      }));
      res.json({ summary, recent, agent: normalizedAgent });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'summary failed' });
    }
  });

  router.put('/v1/memory/:id', async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const { content, sector, agent } = req.body as { content?: string; sector?: string; agent?: string };

      if (!id) return res.status(400).json({ error: 'id_required' });
      if (!content || !content.trim()) {
        return res.status(400).json({ error: 'content_required' });
      }

      let normalizedAgent: string;
      try {
        normalizedAgent = normalizeAgentId(agent);
      } catch (err: any) {
        if (err?.message === 'invalid_agent') {
          return res.status(400).json({ error: 'invalid_agent' });
        }
        return res.status(500).json({ error: 'agent_normalization_failed' });
      }

      const updated = await store.updateById(id, content.trim(), sector as any, normalizedAgent);
      if (!updated) {
        return res.status(404).json({ error: 'not_found', id });
      }
      res.json({ updated: true, id, agent: normalizedAgent });
    } catch (err: any) {
      res.status(500).json({ error: err.message ?? 'update failed' });
    }
  });

  router.delete('/v1/memory/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const agent = req.query.agent as string;
      if (!id) return res.status(400).json({ error: 'id_required' });
      let normalizedAgent: string;
      try {
        normalizedAgent = normalizeAgentId(agent);
      } catch (err: any) {
        if (err?.message === 'invalid_agent') {
          return res.status(400).json({ error: 'invalid_agent' });
        }
        return res.status(500).json({ error: 'agent_normalization_failed' });
      }
      const deleted = store.deleteById(id, normalizedAgent);
      if (!deleted) {
        return res.status(404).json({ error: 'not_found', id });
      }
      res.json({ deleted, agent: normalizedAgent });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'delete failed' });
    }
  });

  router.delete('/v1/memory', (req: Request, res: Response) => {
    try {
      const agent = req.query.agent as string;
      const normalizedAgent = normalizeAgentId(agent);
      const deleted = store.deleteAll(normalizedAgent);
      res.json({ deleted, agent: normalizedAgent });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'delete all failed' });
    }
  });

  // Delete a single semantic graph triple by id
  router.delete('/v1/graph/triple/:id', (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const agent = req.query.agent as string;
      if (!id) return res.status(400).json({ error: 'id_required' });

      const deleted = store.deleteSemanticById(id, agent);
      if (!deleted) {
        return res.status(404).json({ error: 'not_found', id });
      }

      res.json({ deleted });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'triple delete failed' });
    }
  });

  router.post('/v1/search', async (req: Request, res: Response) => {
    const { query, agent, userId } = req.body as { query?: string; agent?: string; userId?: string };
    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'query is required' });
    }
    try {
      const result = await store.query(query, agent, userId);
      res.json(result);
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'query failed' });
    }
  });

  // --- Agent Users ---

  router.get('/v1/users', (req: Request, res: Response) => {
    try {
      const agent = req.query.agent as string;
      const normalizedAgent = normalizeAgentId(agent);
      const users = store.getAgentUsers(normalizedAgent);
      res.json({ users, agent: normalizedAgent });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'failed to fetch users' });
    }
  });

  router.get('/v1/users/:id/memories', (req: Request, res: Response) => {
    try {
      const { id: userId } = req.params;
      const agent = req.query.agent as string;
      const limit = Number(req.query.limit) || 50;
      const normalizedAgent = normalizeAgentId(agent);

      if (!userId) {
        return res.status(400).json({ error: 'user_id_required' });
      }

      const memories = store.getMemoriesForUser(normalizedAgent, userId, limit).map((r) => ({
        id: r.id,
        sector: r.sector,
        agent: r.agentId,
        createdAt: r.createdAt,
        lastAccessed: r.lastAccessed,
        preview: r.content,
        details: (r as any).details,
      }));
      res.json({ memories, userId, agent: normalizedAgent });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'failed to fetch user memories' });
    }
  });

  // Graph traversal endpoints
  router.get('/v1/graph/triples', (req: Request, res: Response) => {
    try {
      const { entity, direction, maxResults, predicate, agent, userId } = req.query;
      if (!entity || typeof entity !== 'string') {
        return res.status(400).json({ error: 'entity query parameter is required' });
      }

      const options: any = {
        maxResults: maxResults ? Number(maxResults) : 100,
        predicateFilter: predicate as string | undefined,
        agent: agent as string,
        userId: userId as string | undefined,
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
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'graph query failed' });
    }
  });

  router.get('/v1/graph/neighbors', (req: Request, res: Response) => {
    try {
      const { entity, agent, userId } = req.query;
      if (!entity || typeof entity !== 'string') {
        return res.status(400).json({ error: 'entity query parameter is required' });
      }

      const neighbors = Array.from(store.graph.findNeighbors(entity, { agent: agent as string, userId: userId as string | undefined }));
      res.json({ entity, neighbors, count: neighbors.length });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'neighbors query failed' });
    }
  });

  router.get('/v1/graph/paths', (req: Request, res: Response) => {
    try {
      const { from, to, maxDepth, agent, userId } = req.query;
      if (!from || typeof from !== 'string' || !to || typeof to !== 'string') {
        return res.status(400).json({ error: 'from and to query parameters are required' });
      }

      const paths = store.graph.findPaths(from, to, {
        maxDepth: maxDepth ? Number(maxDepth) : 3,
        agent: agent as string,
        userId: userId as string | undefined,
      });

      res.json({ from, to, paths, count: paths.length });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'paths query failed' });
    }
  });

  router.get('/v1/graph/visualization', (req: Request, res: Response) => {
    try {
      const { entity, maxDepth, maxNodes, agent, includeHistory, userId } = req.query;
      const agentValue = agent as string;
      const normalizedAgent = normalizeAgentId(agentValue);
      const centerEntity = (entity as string) || null;
      const depth = maxDepth ? Number(maxDepth) : 2;
      const nodeLimit = maxNodes ? Number(maxNodes) : 50;
      const showHistory = includeHistory === 'true' || includeHistory === '1';

      // If no center entity, get a sample of semantic triples
      if (!centerEntity) {
        const allSemantic = store.getRecent(normalizedAgent, 100).filter((r) => r.sector === 'semantic');
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
          agent: normalizedAgent,
        });
      }

      // Build graph from center entity
      const graphOptions = { maxDepth: depth, agent: normalizedAgent, includeInvalidated: showHistory, userId: userId as string | undefined };
      const reachable = store.graph.findReachableEntities(centerEntity, graphOptions);
      const nodes = new Set<string>([centerEntity]);
      const edges: Array<{ source: string; target: string; predicate: string; isHistorical?: boolean }> = [];

      // Add center entity's connections
      const centerTriples = store.graph.findConnectedTriples(centerEntity, { maxResults: 100, agent: normalizedAgent, includeInvalidated: showHistory, userId: userId as string | undefined });
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
        const entityTriples = store.graph.findTriplesBySubject(entity, { maxResults: 10, agent: normalizedAgent, includeInvalidated: showHistory, userId: userId as string | undefined });
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
        agent: normalizedAgent,
      });
    } catch (err: any) {
      if (err?.message === 'invalid_agent') {
        return res.status(400).json({ error: 'invalid_agent' });
      }
      res.status(500).json({ error: err.message ?? 'visualization query failed' });
    }
  });

  return router;
}
