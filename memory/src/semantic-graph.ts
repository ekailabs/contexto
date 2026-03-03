import Database from 'better-sqlite3';
import { normalizeAgentId } from './utils.js';
import type { SemanticMemoryRecord, GraphTraversalOptions } from './types.js';

/**
 * Graph traversal operations for semantic memory (RDF triples)
 * Handles subject-predicate-object queries and path finding
 */
export class SemanticGraphTraversal {
  private db: Database.Database;
  private now: () => number;

  constructor(db: Database.Database, now: () => number) {
    this.db = db;
    this.now = now;
  }

  /**
   * Find all triples where the given entity appears as subject (outgoing edges)
   */
  findTriplesBySubject(
    subject: string,
    options: GraphTraversalOptions = {},
  ): Omit<SemanticMemoryRecord, 'embedding'>[] {
    const { maxResults = 100, includeInvalidated = false, predicateFilter, userId } = options;
    const agentId = normalizeAgentId(options.agent);
    const now = this.now();

    let query = `select id, subject, predicate, object, valid_from as validFrom, valid_to as validTo,
                  created_at as createdAt, updated_at as updatedAt, metadata, agent_id as agentId
           from semantic_memory
           where subject = @subject and agent_id = @agentId`;

    if (!includeInvalidated) {
      query += ` and (valid_to is null or valid_to > @now)`;
    }

    if (predicateFilter) {
      query += ` and predicate = @predicateFilter`;
    }

    if (userId) {
      query += ` and (user_scope is null or user_scope = @userId)`;
    }

    query += ` order by updated_at desc limit @maxResults`;

    const params: Record<string, any> = { subject, now, maxResults, agentId };
    if (predicateFilter) {
      params.predicateFilter = predicateFilter;
    }
    if (userId) {
      params.userId = userId;
    }

    const rows = this.db
      .prepare(query)
      .all(params) as Array<Omit<SemanticMemoryRecord, 'embedding'>>;

    return rows.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata as any) : undefined,
    }));
  }

  /**
   * Find all triples where the given entity appears as object (incoming edges)
   */
  findTriplesByObject(
    object: string,
    options: GraphTraversalOptions = {},
  ): Omit<SemanticMemoryRecord, 'embedding'>[] {
    const { maxResults = 100, includeInvalidated = false, predicateFilter, userId } = options;
    const agentId = normalizeAgentId(options.agent);
    const now = this.now();

    let query = `select id, subject, predicate, object, valid_from as validFrom, valid_to as validTo,
                  created_at as createdAt, updated_at as updatedAt, metadata, agent_id as agentId
           from semantic_memory
           where object = @object and agent_id = @agentId`;

    if (!includeInvalidated) {
      query += ` and (valid_to is null or valid_to > @now)`;
    }

    if (predicateFilter) {
      query += ` and predicate = @predicateFilter`;
    }

    if (userId) {
      query += ` and (user_scope is null or user_scope = @userId)`;
    }

    query += ` order by updated_at desc limit @maxResults`;

    const params: Record<string, any> = { object, now, maxResults, agentId };
    if (predicateFilter) {
      params.predicateFilter = predicateFilter;
    }
    if (userId) {
      params.userId = userId;
    }

    const rows = this.db
      .prepare(query)
      .all(params) as Array<Omit<SemanticMemoryRecord, 'embedding'>>;

    return rows.map((row) => ({
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata as any) : undefined,
    }));
  }

  /**
   * Find all triples connected to an entity (both as subject and object)
   */
  findConnectedTriples(
    entity: string,
    options: GraphTraversalOptions = {},
  ): Omit<SemanticMemoryRecord, 'embedding'>[] {
    const outgoing = this.findTriplesBySubject(entity, options);
    const incoming = this.findTriplesByObject(entity, options);

    // Deduplicate by id
    const seen = new Set<string>();
    const result: Omit<SemanticMemoryRecord, 'embedding'>[] = [];

    for (const triple of [...outgoing, ...incoming]) {
      if (!seen.has(triple.id)) {
        seen.add(triple.id);
        result.push(triple);
      }
    }

    return result;
  }

  /**
   * Find all entities reachable from a given entity within maxDepth steps
   */
  findReachableEntities(
    entity: string,
    options: GraphTraversalOptions = {},
  ): Map<string, number> {
    const { maxDepth = 2 } = options;
    const reachable = new Map<string, number>();
    const queue: Array<{ entity: string; depth: number }> = [{ entity, depth: 0 }];
    const visited = new Set<string>([entity]);

    while (queue.length > 0) {
      const { entity: current, depth } = queue.shift()!;

      if (depth >= maxDepth) {
        continue;
      }

      const outgoing = this.findTriplesBySubject(current, {
        ...options,
        maxResults: 100,
      });

      for (const triple of outgoing) {
        if (!visited.has(triple.object)) {
          visited.add(triple.object);
          reachable.set(triple.object, depth + 1);
          queue.push({ entity: triple.object, depth: depth + 1 });
        }
      }
    }

    return reachable;
  }
}
