import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import * as sqliteVec from 'sqlite-vec';
import type {
  AgentInfo,
  EmbedFn,
  IngestComponents,
  IngestOptions,
  MemoryRecord,
  ProceduralMemoryRecord,
  SemanticMemoryRecord,
  ReflectiveMemoryRecord,
  QueryResult,
  SectorName,
  SemanticTripleInput,
  ReflectiveInput,
} from './types.js';
import { determineConsolidationAction } from './consolidation.js';
import { PBWM_SECTOR_WEIGHTS, scoreRowPBWM } from './scoring.js';
import { cosineSimilarity, DEFAULT_AGENT, normalizeAgentId } from './utils.js';
import { filterAndCapWorkingMemory } from './wm.js';
import { SemanticGraphTraversal } from './semantic-graph.js';

const SECTORS: SectorName[] = ['episodic', 'semantic', 'procedural'];
const PER_SECTOR_K = 4;
const WORKING_MEMORY_CAP = 8;
const VEC_KNN_LIMIT = 50; // generous KNN limit to account for post-filters
const DEFAULT_RETRIEVAL_COUNT = 0;

export class SqliteMemoryStore {
  private db: Database.Database;
  private embed: EmbedFn;
  private now: () => number;
  private vecReady = false;
  private embeddingDim = 0;
  public readonly graph: SemanticGraphTraversal;

  constructor(opts: { dbPath: string; embed: EmbedFn; now?: () => number }) {
    this.db = new Database(opts.dbPath);
    sqliteVec.load(this.db);
    this.embed = opts.embed;
    this.now = opts.now ?? (() => Date.now());
    this.prepareSchema();
    this.graph = new SemanticGraphTraversal(this.db, this.now);
  }

  async ingest(components: IngestComponents, agent?: string, options?: IngestOptions): Promise<MemoryRecord[]> {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    const createdAt = this.now();
    const rows: MemoryRecord[] = [];
    const source = options?.source;
    const origin = options?.origin;
    const userId = options?.userId;

    // Upsert into agent_users when userId is provided
    if (userId) {
      this.upsertAgentUser(agentId, userId);
    }

    // --- Episodic ---
    const episodic = components.episodic;
    if (episodic && typeof episodic === 'string' && episodic.trim()) {
      const embedding = await this.embed(episodic, 'episodic');

      const existingDup = this.findDuplicateMemory(embedding, 'episodic', agentId, 0.9);
      if (existingDup) {
        if (source && !existingDup.source) {
          this.setMemorySource(existingDup.id, source);
        }
        rows.push({
          id: existingDup.id,
          sector: 'episodic',
          content: existingDup.content,
          embedding,
          agentId,
          createdAt: existingDup.createdAt,
          lastAccessed: existingDup.lastAccessed,
          source: existingDup.source ?? source,
        });
      } else {
        const row = this.buildEpisodicRow(episodic, embedding, agentId, createdAt, source, origin, userId);
        this.insertRow(row);
        rows.push(row);
      }
    }

    // --- Semantic (array of triples) ---
    const semanticInput = components.semantic;
    const triples = this.normalizeSemanticInput(semanticInput);

    for (const triple of triples) {
      const textToEmbed = `${triple.subject} ${triple.predicate} ${triple.object}`;
      const embedding = await this.embed(textToEmbed, 'semantic');
      const domain = triple.domain ?? 'world';
      const userScope = domain === 'user' ? (userId ?? null) : null;

      const semanticRow: SemanticMemoryRecord = {
        id: randomUUID(),
        subject: triple.subject,
        predicate: triple.predicate,
        object: triple.object,
        agentId,
        embedding,
        validFrom: createdAt,
        validTo: null,
        createdAt,
        updatedAt: createdAt,
        source,
        domain,
        originType: origin?.originType,
        originActor: origin?.originActor ?? userId,
        originRef: origin?.originRef,
        userScope,
      };

      // Consolidation
      const allFactsForSubject = this.findActiveFactsForSubject(triple.subject, agentId);
      const matchingFacts = await this.findSemanticallyMatchingFacts(
        triple.predicate,
        allFactsForSubject,
        0.9,
      );
      const action = determineConsolidationAction(
        { subject: triple.subject, predicate: triple.predicate, object: triple.object },
        matchingFacts,
      );

      switch (action.type) {
        case 'merge':
          if (source) this.setSemanticSource(action.targetId, source);
          rows.push({
            id: action.targetId,
            sector: 'semantic',
            content: triple.object,
            embedding,
            agentId,
            createdAt,
            lastAccessed: createdAt,
            eventStart: null,
            eventEnd: null,
            source,
          });
          break;

        case 'supersede':
          this.supersedeFact(action.targetId);
          // Fall through to insert

        case 'insert':
          this.insertSemanticRow(semanticRow);
          rows.push({
            id: semanticRow.id,
            sector: 'semantic',
            content: triple.object,
            embedding,
            agentId,
            createdAt,
            lastAccessed: createdAt,
            eventStart: null,
            eventEnd: null,
            source,
          });
          break;
      }
    }

    // --- Procedural ---
    const procInput = components.procedural;
    if (procInput) {
      let textToEmbed = '';
      let procRow: ProceduralMemoryRecord | undefined;

      if (typeof procInput === 'string' && procInput.trim()) {
        textToEmbed = procInput;
        procRow = {
          id: randomUUID(),
          trigger: procInput,
          agentId,
          goal: '',
          context: '',
          result: '',
          steps: [procInput],
          embedding: [],
          createdAt,
          lastAccessed: createdAt,
          source,
          originType: origin?.originType,
          originActor: origin?.originActor ?? userId,
          originRef: origin?.originRef,
          userScope: userId ?? null,
        };
      } else if (typeof procInput === 'object' && procInput.trigger?.trim()) {
        textToEmbed = procInput.trigger;
        procRow = {
          id: randomUUID(),
          trigger: procInput.trigger,
          agentId,
          goal: procInput.goal ?? '',
          context: procInput.context ?? '',
          result: procInput.result ?? '',
          steps: Array.isArray(procInput.steps) ? procInput.steps : [],
          embedding: [],
          createdAt,
          lastAccessed: createdAt,
          source,
          originType: origin?.originType,
          originActor: origin?.originActor ?? userId,
          originRef: origin?.originRef,
          userScope: userId ?? null,
        };
      }

      if (textToEmbed && procRow) {
        const embedding = await this.embed(textToEmbed, 'procedural');
        procRow.embedding = embedding;

        const existingDup = this.findDuplicateProcedural(embedding, agentId, 0.9);
        if (existingDup) {
          if (source && !existingDup.source) {
            this.setProceduralSource(existingDup.id, source);
          }
          rows.push({
            id: existingDup.id,
            sector: 'procedural',
            content: existingDup.trigger,
            embedding,
            agentId,
            createdAt: existingDup.createdAt,
            lastAccessed: existingDup.lastAccessed,
            source: existingDup.source ?? source,
          });
        } else {
          this.insertProceduralRow(procRow);
          rows.push({
            id: procRow.id,
            sector: 'procedural',
            content: procRow.trigger,
            embedding,
            agentId,
            createdAt,
            lastAccessed: createdAt,
            source,
          });
        }
      }
    }

    return rows;
  }

  async query(
    queryText: string,
    agent?: string,
    userId?: string,
  ): Promise<{ workingMemory: QueryResult[]; perSector: Record<SectorName, QueryResult[]>; agentId: string }> {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    const queryEmbeddings: Record<SectorName, number[]> = {} as Record<SectorName, number[]>;
    for (const sector of SECTORS) {
      queryEmbeddings[sector] = await this.embed(queryText, sector);
    }

    this.ensureVecReady(queryEmbeddings.episodic);

    const perSectorResults: Record<SectorName, QueryResult[]> = {
      episodic: [],
      semantic: [],
      procedural: [],
    };

    for (const sector of SECTORS) {
      const candidates = this.vecQueryForSector(sector, queryEmbeddings[sector], agentId, userId);
      const scored = candidates
        .filter((row) => row.similarity >= 0.2)
        .map((row) => scoreRowPBWM(row, PBWM_SECTOR_WEIGHTS[sector]))
        .sort((a, b) => b.gateScore - a.gateScore)
        .slice(0, PER_SECTOR_K)
        .map((row) => ({
          ...row,
          agentId,
          eventStart: (row as any).eventStart ?? null,
          eventEnd: (row as any).eventEnd ?? null,
          details: (row as any).details,
        }));
      perSectorResults[sector] = scored;
      this.touchRows(scored.map((r) => r.id), sector);
    }

    const workingMemory = filterAndCapWorkingMemory(perSectorResults, WORKING_MEMORY_CAP);
    this.bumpRetrievalCounts(workingMemory.map((r) => r.id));
    return { workingMemory, perSector: perSectorResults, agentId };
  }

  getSectorSummary(agent?: string): Array<{ sector: SectorName; count: number; lastCreatedAt: number | null }> {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    const rows = this.db
      .prepare(
        `select sector, count(*) as count, max(created_at) as lastCreatedAt
         from memory
         where agent_id = @agentId
         group by sector`,
      )
      .all({ agentId }) as Array<{ sector: SectorName; count: number; lastCreatedAt: number | null }>;

    const proceduralRow = this.db
      .prepare(
        `select 'procedural' as sector, count(*) as count, max(created_at) as lastCreatedAt
         from procedural_memory
         where agent_id = @agentId`,
      )
      .get({ agentId }) as { sector: SectorName; count: number; lastCreatedAt: number | null };

    const semanticRow = this.db
      .prepare(
        `select 'semantic' as sector, count(*) as count, max(created_at) as lastCreatedAt
         from semantic_memory
         where agent_id = @agentId`,
      )
      .get({ agentId }) as { sector: SectorName; count: number; lastCreatedAt: number | null };

    const defaults = SECTORS.map((s) => ({
      sector: s,
      count: 0,
      lastCreatedAt: null as number | null,
    }));

    const map = new Map(rows.map((r) => [r.sector, r]));
    if (proceduralRow) map.set('procedural', proceduralRow);
    if (semanticRow) map.set('semantic', semanticRow);
    return defaults.map((d) => map.get(d.sector) ?? d);
  }

  getRecent(agent: string | undefined, limit: number, userId?: string): (MemoryRecord & { details?: any })[] {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    const userFilter = userId ? 'and user_scope = @userId' : '';
    const rows = this.db
      .prepare(
        `select id, sector, content, embedding, created_at as createdAt, last_accessed as lastAccessed, '{}' as details, event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount, user_scope as userScope, source
         from memory
         where agent_id = @agentId ${userFilter}
         union all
         select id, 'procedural' as sector, trigger as content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                json_object('trigger', trigger, 'goal', goal, 'context', context, 'result', result, 'steps', json(steps)) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount, user_scope as userScope, source
         from procedural_memory
         where agent_id = @agentId ${userFilter}
         union all
         select id, 'semantic' as sector, subject || ' → ' || predicate || ' → ' || object as content, json('[]') as embedding, created_at as createdAt, updated_at as lastAccessed,
                json_object('subject', subject, 'predicate', predicate, 'object', object, 'validFrom', valid_from, 'validTo', valid_to, 'metadata', metadata, 'domain', domain) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount, user_scope as userScope, source
         from semantic_memory
         where agent_id = @agentId
           and (valid_to is null or valid_to > @now)
           ${userFilter}
         order by createdAt desc
         limit @limit`,
      )
      .all({ agentId, limit, now: this.now(), userId }) as Array<Omit<MemoryRecord, 'embedding' | 'agentId'> & { details: string }>;

    return rows.map((row) => {
      const parsed = {
        ...row,
        agentId,
        embedding: JSON.parse((row as any).embedding) as number[],
        details: row.details ? JSON.parse(row.details) : undefined,
        eventStart: row.eventStart ?? null,
        eventEnd: row.eventEnd ?? null,
      };

      // Ensure steps is always an array if it exists
      if (parsed.details && parsed.details.steps) {
        if (typeof parsed.details.steps === 'string') {
          try {
            parsed.details.steps = JSON.parse(parsed.details.steps);
          } catch {
            parsed.details.steps = [];
          }
        }
        if (!Array.isArray(parsed.details.steps)) {
          parsed.details.steps = [];
        }
      }

      return parsed;
    });
  }

  // --- Agent Management ---

  addAgent(id: string, opts?: { name?: string; soulMd?: string; relevancePrompt?: string }): AgentInfo {
    const agentId = normalizeAgentId(id);
    const now = this.now();
    const name = opts?.name ?? agentId;
    const soulMd = opts?.soulMd ?? null;
    const relevancePrompt = opts?.relevancePrompt ?? null;
    this.db
      .prepare(
        `INSERT INTO agents (id, name, soul_md, relevance_prompt, created_at)
         VALUES (@id, @name, @soulMd, @relevancePrompt, @createdAt)
         ON CONFLICT(id) DO UPDATE SET
           name = @name,
           soul_md = @soulMd,
           relevance_prompt = @relevancePrompt`,
      )
      .run({ id: agentId, name, soulMd, relevancePrompt, createdAt: now });
    return { id: agentId, name, soulMd: soulMd ?? undefined, relevancePrompt: relevancePrompt ?? undefined, createdAt: now };
  }

  getAgent(agentId: string): AgentInfo | undefined {
    const row = this.db
      .prepare('SELECT id, name, soul_md as soulMd, relevance_prompt as relevancePrompt, created_at as createdAt FROM agents WHERE id = @id')
      .get({ id: agentId }) as { id: string; name: string; soulMd: string | null; relevancePrompt: string | null; createdAt: number } | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, soulMd: row.soulMd ?? undefined, relevancePrompt: row.relevancePrompt ?? undefined, createdAt: row.createdAt };
  }

  getAgents(): AgentInfo[] {
    const rows = this.db
      .prepare('SELECT id, name, soul_md as soulMd, relevance_prompt as relevancePrompt, created_at as createdAt FROM agents ORDER BY id')
      .all() as Array<{ id: string; name: string; soulMd: string | null; relevancePrompt: string | null; createdAt: number }>;
    return rows.map((r) => ({ id: r.id, name: r.name, soulMd: r.soulMd ?? undefined, relevancePrompt: r.relevancePrompt ?? undefined, createdAt: r.createdAt }));
  }

  // --- Agent Users ---

  upsertAgentUser(agentId: string, userId: string): void {
    const now = this.now();
    this.db
      .prepare(
        `INSERT INTO agent_users (agent_id, user_id, first_seen, last_seen, interaction_count)
         VALUES (@agentId, @userId, @now, @now, 1)
         ON CONFLICT(agent_id, user_id) DO UPDATE SET
           last_seen = @now,
           interaction_count = interaction_count + 1`,
      )
      .run({ agentId, userId, now });
  }

  getAgentUsers(agentId: string): Array<{ userId: string; firstSeen: number; lastSeen: number; interactionCount: number }> {
    return this.db
      .prepare(
        `SELECT user_id as userId, first_seen as firstSeen, last_seen as lastSeen, interaction_count as interactionCount
         FROM agent_users
         WHERE agent_id = @agentId
         ORDER BY last_seen DESC`,
      )
      .all({ agentId }) as Array<{ userId: string; firstSeen: number; lastSeen: number; interactionCount: number }>;
  }

  getMemoriesForUser(agent: string, userId: string, limit: number = 50): (MemoryRecord & { details?: any })[] {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    const rows = this.db
      .prepare(
        `select id, sector, content, embedding, created_at as createdAt, last_accessed as lastAccessed, '{}' as details, event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount
         from memory
         where agent_id = @agentId and user_scope = @userId
         union all
         select id, 'procedural' as sector, trigger as content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                json_object('trigger', trigger, 'goal', goal, 'context', context, 'result', result, 'steps', json(steps)) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from procedural_memory
         where agent_id = @agentId and user_scope = @userId
         union all
         select id, 'semantic' as sector, subject || ' → ' || predicate || ' → ' || object as content, json('[]') as embedding, created_at as createdAt, updated_at as lastAccessed,
                json_object('subject', subject, 'predicate', predicate, 'object', object, 'validFrom', valid_from, 'validTo', valid_to, 'domain', domain) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from semantic_memory
         where agent_id = @agentId and user_scope = @userId
           and (valid_to is null or valid_to > @now)
         order by createdAt desc
         limit @limit`,
      )
      .all({ agentId, userId, limit, now: this.now() }) as Array<Omit<MemoryRecord, 'embedding' | 'agentId'> & { details: string }>;

    return rows.map((row) => ({
      ...row,
      agentId,
      embedding: JSON.parse((row as any).embedding) as number[],
      details: row.details ? JSON.parse(row.details) : undefined,
      eventStart: row.eventStart ?? null,
      eventEnd: row.eventEnd ?? null,
    }));
  }

  getGlobalMemories(agent: string, limit: number = 50): (MemoryRecord & { details?: any })[] {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    const rows = this.db
      .prepare(
        `select id, sector, content, embedding, created_at as createdAt, last_accessed as lastAccessed, '{}' as details, event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount
         from memory
         where agent_id = @agentId and user_scope is null
         union all
         select id, 'procedural' as sector, trigger as content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                json_object('trigger', trigger, 'goal', goal, 'context', context, 'result', result, 'steps', json(steps)) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from procedural_memory
         where agent_id = @agentId and user_scope is null
         union all
         select id, 'semantic' as sector, subject || ' → ' || predicate || ' → ' || object as content, json('[]') as embedding, created_at as createdAt, updated_at as lastAccessed,
                json_object('subject', subject, 'predicate', predicate, 'object', object, 'validFrom', valid_from, 'validTo', valid_to, 'domain', domain) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from semantic_memory
         where agent_id = @agentId and user_scope is null
           and (valid_to is null or valid_to > @now)
         order by createdAt desc
         limit @limit`,
      )
      .all({ agentId, limit, now: this.now() }) as Array<Omit<MemoryRecord, 'embedding' | 'agentId'> & { details: string }>;

    return rows.map((row) => ({
      ...row,
      agentId,
      embedding: JSON.parse((row as any).embedding) as number[],
      details: row.details ? JSON.parse(row.details) : undefined,
      eventStart: row.eventStart ?? null,
      eventEnd: row.eventEnd ?? null,
    }));
  }

  // --- Reflective ---

  insertReflectiveRow(row: ReflectiveMemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO reflective_memory (
          id, observation, embedding, created_at, last_accessed, agent_id, source,
          origin_type, origin_actor, origin_ref
        ) VALUES (
          @id, @observation, json(@embedding), @createdAt, @lastAccessed, @agentId, @source,
          @originType, @originActor, @originRef
        )`,
      )
      .run({
        id: row.id,
        observation: row.observation,
        embedding: JSON.stringify(row.embedding),
        createdAt: row.createdAt,
        lastAccessed: row.lastAccessed,
        agentId: row.agentId ?? DEFAULT_AGENT,
        source: row.source ?? null,
        originType: row.originType ?? null,
        originActor: row.originActor ?? null,
        originRef: row.originRef ?? null,
      });
    this.insertVecRow('reflective_vec', row.id, row.embedding);
  }

  getReflectiveRows(agentId: string, limit: number): ReflectiveMemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, observation, embedding, created_at as createdAt, last_accessed as lastAccessed,
                agent_id as agentId, source, origin_type as originType, origin_actor as originActor, origin_ref as originRef
         FROM reflective_memory
         WHERE agent_id = @agentId
         ORDER BY last_accessed DESC
         LIMIT @limit`,
      )
      .all({ agentId, limit }) as any[];

    return rows.map((row: any) => ({
      ...row,
      embedding: JSON.parse(row.embedding) as number[],
    }));
  }

  private buildEpisodicRow(
    content: string,
    embedding: number[],
    agentId: string,
    createdAt: number,
    source?: string,
    origin?: { originType?: string; originActor?: string; originRef?: string },
    userId?: string,
  ): MemoryRecord {
    return {
      id: randomUUID(),
      sector: 'episodic' as SectorName,
      content,
      embedding,
      agentId,
      createdAt,
      lastAccessed: createdAt,
      eventStart: createdAt,
      eventEnd: null,
      source,
      originType: origin?.originType,
      originActor: origin?.originActor ?? userId,
      originRef: origin?.originRef,
      userScope: userId ?? null,
    };
  }

  private normalizeSemanticInput(input: IngestComponents['semantic']): SemanticTripleInput[] {
    if (!input) return [];
    if (Array.isArray(input)) {
      return input.filter((t) => t.subject?.trim() && t.predicate?.trim() && t.object?.trim());
    }
    // Single triple object
    if (input.subject?.trim() && input.predicate?.trim() && input.object?.trim()) {
      return [input];
    }
    return [];
  }

  private normalizeReflectiveInput(input: IngestComponents['reflective']): ReflectiveInput[] {
    if (!input) return [];
    if (Array.isArray(input)) {
      return input.filter((r) => r.observation?.trim());
    }
    // Single object
    if (input.observation?.trim()) {
      return [input];
    }
    return [];
  }

  private insertRow(row: MemoryRecord) {
    const embeddingJson = JSON.stringify(row.embedding);
    this.db
      .prepare(
        `insert into memory (
          id, sector, content, embedding, created_at, last_accessed, event_start, event_end, retrieval_count, agent_id, source,
          origin_type, origin_actor, origin_ref, user_scope
        ) values (
          @id, @sector, @content, json(@embedding), @createdAt, @lastAccessed, @eventStart, @eventEnd, @retrievalCount, @agentId, @source,
          @originType, @originActor, @originRef, @userScope
        )`,
      )
      .run({
        id: row.id,
        sector: row.sector,
        content: row.content,
        embedding: embeddingJson,
        createdAt: row.createdAt,
        lastAccessed: row.lastAccessed,
        eventStart: row.eventStart ?? null,
        eventEnd: row.eventEnd ?? null,
        retrievalCount: (row as any).retrievalCount ?? DEFAULT_RETRIEVAL_COUNT,
        agentId: row.agentId ?? DEFAULT_AGENT,
        source: row.source ?? null,
        originType: row.originType ?? null,
        originActor: row.originActor ?? null,
        originRef: row.originRef ?? null,
        userScope: row.userScope ?? null,
      });
    this.insertVecRow('memory_vec', row.id, row.embedding);
  }

  private insertProceduralRow(row: ProceduralMemoryRecord) {
    this.db
      .prepare(
        `insert into procedural_memory (
          id, trigger, goal, context, result, steps, embedding, created_at, last_accessed, agent_id, source,
          origin_type, origin_actor, origin_ref, user_scope
        ) values (
          @id, @trigger, @goal, @context, @result, json(@steps), json(@embedding), @createdAt, @lastAccessed, @agentId, @source,
          @originType, @originActor, @originRef, @userScope
        )`,
      )
      .run({
        id: row.id,
        trigger: row.trigger,
        goal: row.goal ?? '',
        context: row.context ?? '',
        result: row.result ?? '',
        steps: JSON.stringify(row.steps),
        embedding: JSON.stringify(row.embedding),
        createdAt: row.createdAt,
        lastAccessed: row.lastAccessed,
        agentId: row.agentId ?? DEFAULT_AGENT,
        source: row.source ?? null,
        originType: row.originType ?? null,
        originActor: row.originActor ?? null,
        originRef: row.originRef ?? null,
        userScope: row.userScope ?? null,
      });
    this.insertVecRow('procedural_vec', row.id, row.embedding);
  }

  private insertSemanticRow(row: SemanticMemoryRecord) {
    this.db
      .prepare(
        `insert into semantic_memory (
          id, subject, predicate, object, valid_from, valid_to, created_at, updated_at, embedding, metadata, agent_id, source,
          domain, origin_type, origin_actor, origin_ref, user_scope
        ) values (
          @id, @subject, @predicate, @object, @validFrom, @validTo, @createdAt, @updatedAt, json(@embedding), json(@metadata), @agentId, @source,
          @domain, @originType, @originActor, @originRef, @userScope
        )`,
      )
      .run({
        id: row.id,
        subject: row.subject,
        predicate: row.predicate,
        object: row.object,
        validFrom: row.validFrom,
        validTo: row.validTo,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        embedding: JSON.stringify(row.embedding),
        metadata: row.metadata ? JSON.stringify(row.metadata) : null,
        agentId: row.agentId ?? DEFAULT_AGENT,
        source: row.source ?? null,
        domain: row.domain ?? null,
        originType: row.originType ?? null,
        originActor: row.originActor ?? null,
        originRef: row.originRef ?? null,
        userScope: row.userScope ?? null,
      });
    this.insertVecRow('semantic_vec', row.id, row.embedding);
  }

  /**
   * Find a near-duplicate in the memory table (episodic) by embedding similarity.
   * Uses sqlite-vec ANN search.
   */
  private findDuplicateMemory(
    embedding: number[],
    sector: SectorName,
    agentId: string,
    threshold: number,
  ): (MemoryRecord & { source?: string }) | null {
    this.ensureVecReady(embedding);
    const distanceThreshold = 1 - threshold; // cosine distance = 1 - similarity
    const queryJson = JSON.stringify(embedding);

    // Step 1: KNN on vec table
    const knnRows = this.db.prepare(
      `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH @query AND k = 5`,
    ).all({ query: queryJson }) as Array<{ memory_id: string; distance: number }>;

    // Step 2: Check against main table filters
    for (const knn of knnRows) {
      if (knn.distance > distanceThreshold) break; // sorted by distance, no more matches
      const row = this.db.prepare(
        `SELECT id, sector, content, created_at as createdAt, last_accessed as lastAccessed,
                event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount,
                agent_id as agentId, source
         FROM memory WHERE id = @id AND agent_id = @agentId AND sector = @sector`,
      ).get({ id: knn.memory_id, agentId, sector }) as any;
      if (row) return row as MemoryRecord & { source?: string };
    }
    return null;
  }

  /**
   * Find a near-duplicate procedural memory by trigger embedding similarity.
   * Uses sqlite-vec ANN search.
   */
  private findDuplicateProcedural(
    embedding: number[],
    agentId: string,
    threshold: number,
  ): (ProceduralMemoryRecord & { source?: string }) | null {
    this.ensureVecReady(embedding);
    const distanceThreshold = 1 - threshold;
    const queryJson = JSON.stringify(embedding);

    // Step 1: KNN on vec table
    const knnRows = this.db.prepare(
      `SELECT memory_id, distance FROM procedural_vec WHERE embedding MATCH @query AND k = 5`,
    ).all({ query: queryJson }) as Array<{ memory_id: string; distance: number }>;

    // Step 2: Check against main table filters
    for (const knn of knnRows) {
      if (knn.distance > distanceThreshold) break;
      const row = this.db.prepare(
        `SELECT id, trigger, goal, context, result, steps,
                created_at as createdAt, last_accessed as lastAccessed,
                agent_id as agentId, source
         FROM procedural_memory WHERE id = @id AND agent_id = @agentId`,
      ).get({ id: knn.memory_id, agentId }) as any;
      if (row) {
        return {
          ...row,
          steps: JSON.parse(row.steps) as string[],
        } as ProceduralMemoryRecord & { source?: string };
      }
    }
    return null;
  }

  private setMemorySource(id: string, source: string) {
    this.db.prepare('UPDATE memory SET source = @source WHERE id = @id').run({ id, source });
  }

  private setProceduralSource(id: string, source: string) {
    this.db.prepare('UPDATE procedural_memory SET source = @source WHERE id = @id').run({ id, source });
  }

  private setSemanticSource(id: string, source: string) {
    this.db.prepare('UPDATE semantic_memory SET source = @source WHERE id = @id').run({ id, source });
  }

  /**
   * ANN vector query for a sector. Returns candidates with precomputed similarity.
   * Uses a two-step approach: KNN on vec table, then filter via main table.
   */
  private vecQueryForSector(
    sector: SectorName,
    queryEmbedding: number[],
    agentId: string,
    userId?: string,
  ): Array<MemoryRecord & { similarity: number }> {
    const queryJson = JSON.stringify(queryEmbedding);
    const k = VEC_KNN_LIMIT;

    switch (sector) {
      case 'procedural': {
        const knnRows = this.db.prepare(
          `SELECT memory_id, distance FROM procedural_vec WHERE embedding MATCH @query AND k = @k`,
        ).all({ query: queryJson, k }) as Array<{ memory_id: string; distance: number }>;

        if (knnRows.length === 0) return [];
        const ids = knnRows.map((r) => r.memory_id);
        const distMap = new Map(knnRows.map((r) => [r.memory_id, r.distance]));
        const placeholders = ids.map(() => '?').join(',');
        const userFilter = userId ? `AND (user_scope IS NULL OR user_scope = ?)` : '';
        const params: any[] = [...ids, agentId];
        if (userId) params.push(userId);

        const rows = this.db.prepare(`
          SELECT id, 'procedural' as sector, trigger as content,
                 created_at as createdAt, last_accessed as lastAccessed,
                 agent_id as agentId, source,
                 trigger, goal, context, result, steps
          FROM procedural_memory
          WHERE id IN (${placeholders}) AND agent_id = ? ${userFilter}
        `).all(...params) as any[];

        return rows.map((row: any) => ({
          ...row,
          steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps,
          similarity: 1 - (distMap.get(row.id) ?? 1),
          details: {
            trigger: row.trigger,
            goal: row.goal,
            context: row.context,
            result: row.result,
            steps: typeof row.steps === 'string' ? JSON.parse(row.steps) : row.steps,
          },
        }));
      }
      case 'semantic': {
        const knnRows = this.db.prepare(
          `SELECT memory_id, distance FROM semantic_vec WHERE embedding MATCH @query AND k = @k`,
        ).all({ query: queryJson, k }) as Array<{ memory_id: string; distance: number }>;

        if (knnRows.length === 0) return [];
        const ids = knnRows.map((r) => r.memory_id);
        const distMap = new Map(knnRows.map((r) => [r.memory_id, r.distance]));
        const placeholders = ids.map(() => '?').join(',');
        const now = this.now();
        const userFilter = userId ? `AND (user_scope IS NULL OR user_scope = ?)` : '';
        const params: any[] = [...ids, agentId, now];
        if (userId) params.push(userId);

        const rows = this.db.prepare(`
          SELECT id, 'semantic' as sector,
                 subject || ' ' || predicate || ' ' || object as content,
                 created_at as createdAt, updated_at as lastAccessed,
                 agent_id as agentId,
                 subject, predicate, object, valid_from as validFrom, valid_to as validTo, domain
          FROM semantic_memory
          WHERE id IN (${placeholders}) AND agent_id = ?
            AND (valid_to IS NULL OR valid_to > ?)
            ${userFilter}
        `).all(...params) as any[];

        return rows.map((row: any) => ({
          ...row,
          similarity: 1 - (distMap.get(row.id) ?? 1),
          details: {
            subject: row.subject,
            predicate: row.predicate,
            object: row.object,
            validFrom: row.validFrom,
            validTo: row.validTo,
            domain: row.domain,
          },
        }));
      }
      default: {
        // episodic — from memory table
        const knnRows = this.db.prepare(
          `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH @query AND k = @k`,
        ).all({ query: queryJson, k }) as Array<{ memory_id: string; distance: number }>;

        if (knnRows.length === 0) return [];
        const ids = knnRows.map((r) => r.memory_id);
        const distMap = new Map(knnRows.map((r) => [r.memory_id, r.distance]));
        const placeholders = ids.map(() => '?').join(',');
        const userFilter = userId ? `AND (user_scope IS NULL OR user_scope = ?)` : '';
        const params: any[] = [...ids, agentId, sector];
        if (userId) params.push(userId);

        const rows = this.db.prepare(`
          SELECT id, sector, content,
                 created_at as createdAt, last_accessed as lastAccessed,
                 event_start as eventStart, event_end as eventEnd,
                 retrieval_count as retrievalCount,
                 agent_id as agentId, source
          FROM memory
          WHERE id IN (${placeholders}) AND agent_id = ? AND sector = ? ${userFilter}
        `).all(...params) as any[];

        return rows.map((row: any) => ({
          ...row,
          similarity: 1 - (distMap.get(row.id) ?? 1),
        }));
      }
    }
  }

  private touchRows(ids: string[], sector?: SectorName) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const now = this.now();

    // Each sector lives in its own table
    const table =
      sector === 'procedural' ? 'procedural_memory'
        : sector === 'semantic' ? 'semantic_memory'
        : 'memory';
    const timeCol = sector === 'semantic' ? 'updated_at' : 'last_accessed';

    this.db
      .prepare(`update ${table} set ${timeCol} = ? where id in (${placeholders})`)
      .run(now, ...ids);
  }

  private prepareSchema() {
    this.db
      .prepare(
        `create table if not exists memory (
          id text primary key,
          sector text not null,
          content text not null,
          embedding json not null,
          created_at integer not null,
          last_accessed integer not null,
          event_start integer,
          event_end integer,
          retrieval_count integer not null default 0,
          agent_id text not null default '${DEFAULT_AGENT}',
          source text,
          origin_type text,
          origin_actor text,
          origin_ref text,
          user_scope text
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_memory_sector on memory(sector)').run();
    this.db.prepare('create index if not exists idx_memory_last_accessed on memory(last_accessed)').run();
    this.db.prepare('create index if not exists idx_memory_agent_sector on memory(agent_id, sector, last_accessed)').run();
    this.db.prepare('create index if not exists idx_memory_user_scope on memory(user_scope)').run();

    this.db
      .prepare(
        `create table if not exists procedural_memory (
          id text primary key,
          trigger text not null,
          goal text,
          context text,
          result text,
          steps json not null,
          embedding json not null,
          created_at integer not null,
          last_accessed integer not null,
          agent_id text not null default '${DEFAULT_AGENT}',
          source text,
          origin_type text,
          origin_actor text,
          origin_ref text,
          user_scope text
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_proc_last_accessed on procedural_memory(last_accessed)').run();
    this.db.prepare('create index if not exists idx_proc_agent on procedural_memory(agent_id, last_accessed)').run();
    this.db.prepare('create index if not exists idx_proc_user_scope on procedural_memory(user_scope)').run();

    this.db
      .prepare(
        `create table if not exists semantic_memory (
          id text primary key,
          subject text not null,
          predicate text not null,
          object text not null,
          valid_from integer not null,
          valid_to integer,
          created_at integer not null,
          updated_at integer not null,
          embedding json not null,
          metadata json,
          agent_id text not null default '${DEFAULT_AGENT}',
          source text,
          domain text,
          origin_type text,
          origin_actor text,
          origin_ref text,
          user_scope text
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_semantic_subject_pred on semantic_memory(subject, predicate)').run();
    this.db.prepare('create index if not exists idx_semantic_object on semantic_memory(object)').run();
    this.db.prepare('create index if not exists idx_semantic_agent on semantic_memory(agent_id, updated_at)').run();
    this.db.prepare('create index if not exists idx_semantic_slot on semantic_memory(subject, predicate, agent_id)').run();
    this.db.prepare('create index if not exists idx_semantic_user_scope on semantic_memory(user_scope)').run();
    this.db.prepare('create index if not exists idx_semantic_domain on semantic_memory(domain)').run();

    this.db
      .prepare(
        `create table if not exists reflective_memory (
          id text primary key,
          observation text not null,
          embedding json not null,
          created_at integer not null,
          last_accessed integer not null,
          agent_id text not null default '${DEFAULT_AGENT}',
          source text,
          origin_type text,
          origin_actor text,
          origin_ref text
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_reflective_agent on reflective_memory(agent_id, last_accessed)').run();

    this.db
      .prepare(
        `create table if not exists agent_users (
          agent_id text not null,
          user_id text not null,
          first_seen integer not null,
          last_seen integer not null,
          interaction_count integer not null default 1,
          primary key (agent_id, user_id)
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_agent_users_agent on agent_users(agent_id)').run();

    this.db
      .prepare(
        `create table if not exists agents (
          id text primary key,
          name text not null,
          soul_md text,
          created_at integer not null
        )`,
      )
      .run();

    // Migration: add relevance_prompt column to agents table (idempotent)
    try {
      this.db.prepare('ALTER TABLE agents ADD COLUMN relevance_prompt text default null').run();
    } catch (_) {
      // Column already exists — ignore
    }

    // Ensure the default agent always exists
    this.upsertDefaultAgent();
  }

  private upsertDefaultAgent() {
    this.db
      .prepare('insert or ignore into agents (id, name, created_at) values (@id, @name, @createdAt)')
      .run({ id: DEFAULT_AGENT, name: DEFAULT_AGENT, createdAt: this.now() });
  }

  ensureAgentExists(agentId: string) {
    const exists = this.db
      .prepare('select 1 from agents where id = @id')
      .get({ id: agentId });
    if (!exists) {
      throw new Error('agent_not_found');
    }
  }

  /**
   * Find all active (non-expired) facts for a subject.
   * Used for semantic similarity matching during consolidation.
   */
  findActiveFactsForSubject(
    subject: string,
    agentId: string
  ): Array<{ id: string; predicate: string; object: string; updatedAt: number }> {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT id, predicate, object, updated_at as updatedAt
         FROM semantic_memory
         WHERE subject = @subject
           AND agent_id = @agentId
           AND (valid_to IS NULL OR valid_to > @now)
         ORDER BY updated_at DESC`
      )
      .all({ subject, agentId, now }) as Array<{ id: string; predicate: string; object: string; updatedAt: number }>;
    return rows;
  }

  /**
   * Find facts with semantically similar predicates (using embeddings).
   * Returns facts where predicate similarity >= threshold.
   */
  async findSemanticallyMatchingFacts(
    newPredicate: string,
    existingFacts: Array<{ id: string; predicate: string; object: string; updatedAt: number }>,
    threshold: number = 0.9
  ): Promise<Array<{ id: string; object: string; updatedAt: number; similarity: number }>> {
    if (existingFacts.length === 0) return [];

    // Embed the new predicate
    const newPredicateEmbedding = await this.embed(newPredicate, 'semantic');

    // Get unique predicates to embed (avoid duplicate embedding calls)
    const uniquePredicates = [...new Set(existingFacts.map(f => f.predicate))];
    const predicateEmbeddings = new Map<string, number[]>();

    for (const pred of uniquePredicates) {
      predicateEmbeddings.set(pred, await this.embed(pred, 'semantic'));
    }

    // Filter facts by predicate similarity
    const matchingFacts: Array<{ id: string; object: string; updatedAt: number; similarity: number }> = [];

    for (const fact of existingFacts) {
      const factPredicateEmbedding = predicateEmbeddings.get(fact.predicate)!;
      const similarity = cosineSimilarity(newPredicateEmbedding, factPredicateEmbedding);

      if (similarity >= threshold) {
        matchingFacts.push({
          id: fact.id,
          object: fact.object,
          updatedAt: fact.updatedAt,
          similarity
        });
      }
    }

    // Sort by similarity desc, then by updatedAt desc
    matchingFacts.sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      return b.updatedAt - a.updatedAt;
    });

    return matchingFacts;
  }

  /**
   * Supersede a semantic fact by closing its validity window.
   * The fact remains in the database for historical queries.
   */
  supersedeFact(id: string): void {
    this.db
      .prepare(
        `UPDATE semantic_memory
         SET valid_to = @now,
             updated_at = @now
         WHERE id = @id`
      )
      .run({ id, now: this.now() });
  }

  async updateById(id: string, content: string, sector?: SectorName, agent?: string, userScope?: string | null): Promise<boolean> {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    // First, get the existing record to preserve sector if not changing
    const existing = this.db
      .prepare('select sector from memory where id = ? and agent_id = ?')
      .get(id, agentId) as { sector: SectorName } | undefined;

    if (!existing) {
      return false;
    }

    const targetSector = sector ?? existing.sector;

    // Regenerate embedding with new content
    const embedding = await this.embed(content, targetSector);

    // Build update dynamically to support optional userScope
    const setClauses = ['content = ?', 'sector = ?', 'embedding = json(?)', 'last_accessed = ?'];
    const params: any[] = [content, targetSector, JSON.stringify(embedding), this.now()];

    if (userScope !== undefined) {
      setClauses.push('user_scope = ?');
      params.push(userScope);
    }

    params.push(id, agentId);
    const stmt = this.db.prepare(
      `update memory set ${setClauses.join(', ')} where id = ? and agent_id = ?`
    );
    const res = stmt.run(...params);

    if (res.changes > 0) {
      this.deleteVecRow('memory_vec', id);
      this.insertVecRow('memory_vec', id, embedding);
    }

    return res.changes > 0;
  }

  deleteById(id: string, agent?: string): number {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    const res1 = this.db.prepare('delete from memory where id = ? and agent_id = ?').run(id, agentId);
    const res2 = this.db.prepare('delete from procedural_memory where id = ? and agent_id = ?').run(id, agentId);
    const res3 = this.db.prepare('delete from semantic_memory where id = ? and agent_id = ?').run(id, agentId);
    const res4 = this.db.prepare('delete from reflective_memory where id = ? and agent_id = ?').run(id, agentId);
    const total = (res1.changes ?? 0) + (res2.changes ?? 0) + (res3.changes ?? 0) + (res4.changes ?? 0);
    if (total > 0 && this.vecReady) {
      this.deleteVecRow('memory_vec', id);
      this.deleteVecRow('procedural_vec', id);
      this.deleteVecRow('semantic_vec', id);
      this.deleteVecRow('reflective_vec', id);
    }
    return total;
  }

  deleteAll(agent?: string): number {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    // Collect IDs for vec table cleanup before deleting
    if (this.vecReady) {
      const memIds = this.db.prepare('SELECT id FROM memory WHERE agent_id = ?').all(agentId) as Array<{ id: string }>;
      const procIds = this.db.prepare('SELECT id FROM procedural_memory WHERE agent_id = ?').all(agentId) as Array<{ id: string }>;
      const semIds = this.db.prepare('SELECT id FROM semantic_memory WHERE agent_id = ?').all(agentId) as Array<{ id: string }>;
      const refIds = this.db.prepare('SELECT id FROM reflective_memory WHERE agent_id = ?').all(agentId) as Array<{ id: string }>;
      for (const { id } of memIds) this.deleteVecRow('memory_vec', id);
      for (const { id } of procIds) this.deleteVecRow('procedural_vec', id);
      for (const { id } of semIds) this.deleteVecRow('semantic_vec', id);
      for (const { id } of refIds) this.deleteVecRow('reflective_vec', id);
    }
    const res1 = this.db.prepare('delete from memory where agent_id = ?').run(agentId);
    const res2 = this.db.prepare('delete from procedural_memory where agent_id = ?').run(agentId);
    const res3 = this.db.prepare('delete from semantic_memory where agent_id = ?').run(agentId);
    const res4 = this.db.prepare('delete from reflective_memory where agent_id = ?').run(agentId);
    return (res1.changes ?? 0) + (res2.changes ?? 0) + (res3.changes ?? 0) + (res4.changes ?? 0);
  }

  deleteAgent(agent?: string): number {
    const agentId = normalizeAgentId(agent);
    if (agentId === DEFAULT_AGENT) {
      throw new Error('cannot_delete_default_agent');
    }
    // Delete all memories for this agent
    const deletedCount = this.deleteAll(agentId);
    // Delete the agent itself from the agents table
    this.db.prepare('delete from agents where id = ?').run(agentId);
    // Delete agent_users entries for this agent
    this.db.prepare('delete from agent_users where agent_id = ?').run(agentId);
    return deletedCount;
  }

  deleteSemanticById(id: string, agent?: string): number {
    const agentId = normalizeAgentId(agent);
    this.ensureAgentExists(agentId);
    const res = this.db.prepare('delete from semantic_memory where id = ? and agent_id = ?').run(id, agentId);
    if ((res.changes ?? 0) > 0 && this.vecReady) {
      this.deleteVecRow('semantic_vec', id);
    }
    return res.changes ?? 0;
  }

  private bumpRetrievalCounts(ids: string[]) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db
      .prepare(
        `update memory
         set retrieval_count = retrieval_count + 1,
             last_accessed = ?
         where id in (${placeholders})`,
      )
      .run(this.now(), ...ids);
  }

  // --- sqlite-vec helpers ---

  /**
   * Ensure vec tables exist. Called lazily on first embed/query.
   */
  private ensureVecReady(embedding: number[]) {
    if (this.vecReady) return;
    this.embeddingDim = embedding.length;
    this.createVecTables();
    this.vecReady = true;
  }

  /**
   * Create the vec0 virtual tables for each sector.
   */
  private createVecTables() {
    const N = this.embeddingDim;
    const tables = ['memory_vec', 'procedural_vec', 'semantic_vec', 'reflective_vec'];
    for (const table of tables) {
      this.db.prepare(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING vec0(
          +memory_id text,
          embedding float[${N}] distance_metric=cosine
        )`,
      ).run();
    }
  }

  /**
   * Insert a row into a vec0 virtual table.
   */
  private insertVecRow(vecTable: string, id: string, embedding: number[]) {
    if (!this.vecReady) {
      this.ensureVecReady(embedding);
    }
    this.db
      .prepare(`INSERT INTO ${vecTable}(memory_id, embedding) VALUES (@id, @embedding)`)
      .run({ id, embedding: JSON.stringify(embedding) });
  }

  /**
   * Delete a row from a vec0 virtual table by memory_id.
   * Uses a subquery to find the rowid from the auxiliary column.
   */
  private deleteVecRow(vecTable: string, id: string) {
    if (!this.vecReady) return;
    // vec0 tables require deletion by rowid.
    // We find the rowid via the auxiliary memory_id column.
    const row = this.db
      .prepare(`SELECT rowid FROM ${vecTable} WHERE memory_id = @id`)
      .get({ id }) as { rowid: number } | undefined;
    if (row) {
      this.db.prepare(`DELETE FROM ${vecTable} WHERE rowid = ?`).run(row.rowid);
    }
  }
}
