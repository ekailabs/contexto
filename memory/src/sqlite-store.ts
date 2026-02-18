import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type {
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
import { cosineSimilarity, DEFAULT_PROFILE, normalizeProfileSlug } from './utils.js';
import { filterAndCapWorkingMemory } from './wm.js';
import { SemanticGraphTraversal } from './semantic-graph.js';

const SECTORS: SectorName[] = ['episodic', 'semantic', 'procedural', 'reflective'];
const PER_SECTOR_K = 4;
const WORKING_MEMORY_CAP = 8;
const SECTOR_SCAN_LIMIT = 200; // simple scan instead of ANN for v0
const DEFAULT_RETRIEVAL_COUNT = 0;

export class SqliteMemoryStore {
  private db: Database.Database;
  private embed: EmbedFn;
  private now: () => number;
  public readonly graph: SemanticGraphTraversal;

  constructor(opts: { dbPath: string; embed: EmbedFn; now?: () => number }) {
    this.db = new Database(opts.dbPath);
    this.embed = opts.embed;
    this.now = opts.now ?? (() => Date.now());
    this.prepareSchema();
    this.graph = new SemanticGraphTraversal(this.db, this.now);
  }

  async ingest(components: IngestComponents, profile?: string, options?: IngestOptions): Promise<MemoryRecord[]> {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const createdAt = this.now();
    const rows: MemoryRecord[] = [];
    const source = options?.source;
    const dedup = options?.deduplicate === true;
    const origin = options?.origin;
    const userId = options?.userId;

    // Upsert into agent_users when userId is provided
    if (userId) {
      this.upsertAgentUser(profileId, userId);
    }

    // --- Episodic ---
    const episodic = components.episodic;
    if (episodic && typeof episodic === 'string' && episodic.trim()) {
      const embedding = await this.embed(episodic, 'episodic');

      if (dedup) {
        const existingDup = this.findDuplicateMemory(embedding, 'episodic', profileId, 0.9);
        if (existingDup) {
          if (source && !existingDup.source) {
            this.setMemorySource(existingDup.id, source);
          }
          rows.push({
            id: existingDup.id,
            sector: 'episodic',
            content: existingDup.content,
            embedding,
            profileId,
            createdAt: existingDup.createdAt,
            lastAccessed: existingDup.lastAccessed,
            source: existingDup.source ?? source,
          });
        } else {
          const row = this.buildEpisodicRow(episodic, embedding, profileId, createdAt, source, origin, userId);
          this.insertRow(row);
          rows.push(row);
        }
      } else {
        const row = this.buildEpisodicRow(episodic, embedding, profileId, createdAt, source, origin, userId);
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
        profileId,
        embedding,
        validFrom: createdAt,
        validTo: null,
        createdAt,
        updatedAt: createdAt,
        strength: 1.0,
        source,
        domain,
        originType: origin?.originType,
        originActor: origin?.originActor ?? userId,
        originRef: origin?.originRef,
        userScope,
      };

      // Consolidation
      const allFactsForSubject = this.findActiveFactsForSubject(triple.subject, profileId);
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
          if (dedup) {
            if (source) this.setSemanticSource(action.targetId, source);
          } else {
            this.strengthenFact(action.targetId);
          }
          rows.push({
            id: action.targetId,
            sector: 'semantic',
            content: triple.object,
            embedding,
            profileId,
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
            profileId,
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
          profileId,
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
          profileId,
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

        if (dedup) {
          const existingDup = this.findDuplicateProcedural(embedding, profileId, 0.9);
          if (existingDup) {
            if (source && !existingDup.source) {
              this.setProceduralSource(existingDup.id, source);
            }
            rows.push({
              id: existingDup.id,
              sector: 'procedural',
              content: existingDup.trigger,
              embedding,
              profileId,
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
              profileId,
              createdAt,
              lastAccessed: createdAt,
              source,
            });
          }
        } else {
          this.insertProceduralRow(procRow);
          rows.push({
            id: procRow.id,
            sector: 'procedural',
            content: procRow.trigger,
            embedding,
            profileId,
            createdAt,
            lastAccessed: createdAt,
            source,
          });
        }
      }
    }

    // --- Reflective (requires attribution — skip if no origin) ---
    const reflectiveInput = components.reflective;
    const reflections = (origin?.originType) ? this.normalizeReflectiveInput(reflectiveInput) : [];

    for (const ref of reflections) {
      const embedding = await this.embed(ref.observation, 'reflective');
      const refRow: ReflectiveMemoryRecord = {
        id: randomUUID(),
        observation: ref.observation,
        profileId,
        embedding,
        createdAt,
        lastAccessed: createdAt,
        source,
        originType: origin!.originType,
        originActor: origin!.originActor ?? userId,
        originRef: origin!.originRef,
      };
      this.insertReflectiveRow(refRow);
      rows.push({
        id: refRow.id,
        sector: 'reflective',
        content: ref.observation,
        embedding,
        profileId,
        createdAt,
        lastAccessed: createdAt,
        source,
      });
    }

    return rows;
  }

  async query(
    queryText: string,
    profile?: string,
    userId?: string,
  ): Promise<{ workingMemory: QueryResult[]; perSector: Record<SectorName, QueryResult[]>; profileId: string }> {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const queryEmbeddings: Record<SectorName, number[]> = {} as Record<SectorName, number[]>;
    for (const sector of SECTORS) {
      queryEmbeddings[sector] = await this.embed(queryText, sector);
    }

    const perSectorResults: Record<SectorName, QueryResult[]> = {
      episodic: [],
      semantic: [],
      procedural: [],
      reflective: [],
    };

    for (const sector of SECTORS) {
      const candidates = this.getCandidatesForSector(sector, profileId, userId);
      const scored = candidates
        .filter((row) => cosineSimilarity(queryEmbeddings[sector], row.embedding) >= 0.2)
        .map((row) => scoreRowPBWM(row, queryEmbeddings[sector], PBWM_SECTOR_WEIGHTS[sector]))
        .sort((a, b) => b.gateScore - a.gateScore)
        .slice(0, PER_SECTOR_K)
        .map((row) => ({
          ...row,
          profileId,
          // propagate temporal fields for episodic; procedural has none
          eventStart: (row as any).eventStart ?? null,
          eventEnd: (row as any).eventEnd ?? null,
          details: (row as any).details,
        }));
      perSectorResults[sector] = scored;
      this.touchRows(scored.map((r) => r.id), sector);
    }

    const workingMemory = filterAndCapWorkingMemory(perSectorResults, WORKING_MEMORY_CAP);
    this.bumpRetrievalCounts(workingMemory.map((r) => r.id));
    return { workingMemory, perSector: perSectorResults, profileId };
  }

  getSectorSummary(profile?: string): Array<{ sector: SectorName; count: number; lastCreatedAt: number | null }> {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const rows = this.db
      .prepare(
        `select sector, count(*) as count, max(created_at) as lastCreatedAt
         from memory
         where profile_id = @profileId
         group by sector`,
      )
      .all({ profileId }) as Array<{ sector: SectorName; count: number; lastCreatedAt: number | null }>;

    const proceduralRow = this.db
      .prepare(
        `select 'procedural' as sector, count(*) as count, max(created_at) as lastCreatedAt
         from procedural_memory
         where profile_id = @profileId`,
      )
      .get({ profileId }) as { sector: SectorName; count: number; lastCreatedAt: number | null };

    const semanticRow = this.db
      .prepare(
        `select 'semantic' as sector, count(*) as count, max(created_at) as lastCreatedAt
         from semantic_memory
         where profile_id = @profileId`,
      )
      .get({ profileId }) as { sector: SectorName; count: number; lastCreatedAt: number | null };

    const reflectiveRow = this.db
      .prepare(
        `select 'reflective' as sector, count(*) as count, max(created_at) as lastCreatedAt
         from reflective_memory
         where profile_id = @profileId`,
      )
      .get({ profileId }) as { sector: SectorName; count: number; lastCreatedAt: number | null };

    const defaults = SECTORS.map((s) => ({
      sector: s,
      count: 0,
      lastCreatedAt: null as number | null,
    }));

    const map = new Map(rows.map((r) => [r.sector, r]));
    if (proceduralRow) map.set('procedural', proceduralRow);
    if (semanticRow) map.set('semantic', semanticRow);
    if (reflectiveRow) map.set('reflective', reflectiveRow);
    return defaults.map((d) => map.get(d.sector) ?? d);
  }

  getRecent(profile: string | undefined, limit: number): (MemoryRecord & { details?: any })[] {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const rows = this.db
      .prepare(
        `select id, sector, content, embedding, created_at as createdAt, last_accessed as lastAccessed, '{}' as details, event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount
         from memory
         where profile_id = @profileId
         union all
         select id, 'procedural' as sector, trigger as content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                json_object('trigger', trigger, 'goal', goal, 'context', context, 'result', result, 'steps', json(steps)) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from procedural_memory
         where profile_id = @profileId
         union all
         select id, 'semantic' as sector, object as content, json('[]') as embedding, created_at as createdAt, updated_at as lastAccessed,
                json_object('subject', subject, 'predicate', predicate, 'object', object, 'validFrom', valid_from, 'validTo', valid_to, 'strength', strength, 'metadata', metadata, 'domain', domain) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from semantic_memory
         where profile_id = @profileId
           and (valid_to is null or valid_to > @now)
         union all
         select id, 'reflective' as sector, observation as content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                '{}' as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from reflective_memory
         where profile_id = @profileId
         order by createdAt desc
         limit @limit`,
      )
      .all({ profileId, limit, now: this.now() }) as Array<Omit<MemoryRecord, 'embedding' | 'profileId'> & { details: string }>;

    return rows.map((row) => {
      const parsed = {
        ...row,
        profileId,
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

  getMemoriesForUser(profile: string, userId: string, limit: number = 50): (MemoryRecord & { details?: any })[] {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const rows = this.db
      .prepare(
        `select id, sector, content, embedding, created_at as createdAt, last_accessed as lastAccessed, '{}' as details, event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount
         from memory
         where profile_id = @profileId and user_scope = @userId
         union all
         select id, 'procedural' as sector, trigger as content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                json_object('trigger', trigger, 'goal', goal, 'context', context, 'result', result, 'steps', json(steps)) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from procedural_memory
         where profile_id = @profileId and user_scope = @userId
         union all
         select id, 'semantic' as sector, object as content, json('[]') as embedding, created_at as createdAt, updated_at as lastAccessed,
                json_object('subject', subject, 'predicate', predicate, 'object', object, 'validFrom', valid_from, 'validTo', valid_to, 'strength', strength, 'domain', domain) as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from semantic_memory
         where profile_id = @profileId and user_scope = @userId
           and (valid_to is null or valid_to > @now)
         union all
         select id, 'reflective' as sector, observation as content, embedding, created_at as createdAt, last_accessed as lastAccessed,
                '{}' as details,
                null as eventStart, null as eventEnd, 0 as retrievalCount
         from reflective_memory
         where profile_id = @profileId and origin_actor = @userId
         order by createdAt desc
         limit @limit`,
      )
      .all({ profileId, userId, limit, now: this.now() }) as Array<Omit<MemoryRecord, 'embedding' | 'profileId'> & { details: string }>;

    return rows.map((row) => ({
      ...row,
      profileId,
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
          id, observation, embedding, created_at, last_accessed, profile_id, source,
          origin_type, origin_actor, origin_ref
        ) VALUES (
          @id, @observation, json(@embedding), @createdAt, @lastAccessed, @profileId, @source,
          @originType, @originActor, @originRef
        )`,
      )
      .run({
        id: row.id,
        observation: row.observation,
        embedding: JSON.stringify(row.embedding),
        createdAt: row.createdAt,
        lastAccessed: row.lastAccessed,
        profileId: row.profileId ?? DEFAULT_PROFILE,
        source: row.source ?? null,
        originType: row.originType ?? null,
        originActor: row.originActor ?? null,
        originRef: row.originRef ?? null,
      });
  }

  getReflectiveRows(profileId: string, limit: number): ReflectiveMemoryRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, observation, embedding, created_at as createdAt, last_accessed as lastAccessed,
                profile_id as profileId, source, origin_type as originType, origin_actor as originActor, origin_ref as originRef
         FROM reflective_memory
         WHERE profile_id = @profileId
         ORDER BY last_accessed DESC
         LIMIT @limit`,
      )
      .all({ profileId, limit }) as any[];

    return rows.map((row: any) => ({
      ...row,
      embedding: JSON.parse(row.embedding) as number[],
    }));
  }

  private buildEpisodicRow(
    content: string,
    embedding: number[],
    profileId: string,
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
      profileId,
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
    this.db
      .prepare(
        `insert into memory (
          id, sector, content, embedding, created_at, last_accessed, event_start, event_end, retrieval_count, profile_id, source,
          origin_type, origin_actor, origin_ref, user_scope
        ) values (
          @id, @sector, @content, json(@embedding), @createdAt, @lastAccessed, @eventStart, @eventEnd, @retrievalCount, @profileId, @source,
          @originType, @originActor, @originRef, @userScope
        )`,
      )
      .run({
        id: row.id,
        sector: row.sector,
        content: row.content,
        embedding: JSON.stringify(row.embedding),
        createdAt: row.createdAt,
        lastAccessed: row.lastAccessed,
        eventStart: row.eventStart ?? null,
        eventEnd: row.eventEnd ?? null,
        retrievalCount: (row as any).retrievalCount ?? DEFAULT_RETRIEVAL_COUNT,
        profileId: row.profileId ?? DEFAULT_PROFILE,
        source: row.source ?? null,
        originType: row.originType ?? null,
        originActor: row.originActor ?? null,
        originRef: row.originRef ?? null,
        userScope: row.userScope ?? null,
      });
  }

  private insertProceduralRow(row: ProceduralMemoryRecord) {
    this.db
      .prepare(
        `insert into procedural_memory (
          id, trigger, goal, context, result, steps, embedding, created_at, last_accessed, profile_id, source,
          origin_type, origin_actor, origin_ref, user_scope
        ) values (
          @id, @trigger, @goal, @context, @result, json(@steps), json(@embedding), @createdAt, @lastAccessed, @profileId, @source,
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
        profileId: row.profileId ?? DEFAULT_PROFILE,
        source: row.source ?? null,
        originType: row.originType ?? null,
        originActor: row.originActor ?? null,
        originRef: row.originRef ?? null,
        userScope: row.userScope ?? null,
      });
  }

  private insertSemanticRow(row: SemanticMemoryRecord) {
    this.db
      .prepare(
        `insert into semantic_memory (
          id, subject, predicate, object, valid_from, valid_to, created_at, updated_at, embedding, metadata, profile_id, strength, source,
          domain, origin_type, origin_actor, origin_ref, user_scope
        ) values (
          @id, @subject, @predicate, @object, @validFrom, @validTo, @createdAt, @updatedAt, json(@embedding), json(@metadata), @profileId, @strength, @source,
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
        profileId: row.profileId ?? DEFAULT_PROFILE,
        strength: row.strength ?? 1.0,
        source: row.source ?? null,
        domain: row.domain ?? null,
        originType: row.originType ?? null,
        originActor: row.originActor ?? null,
        originRef: row.originRef ?? null,
        userScope: row.userScope ?? null,
      });
  }

  /**
   * Find a near-duplicate in the memory table (episodic) by embedding similarity.
   */
  private findDuplicateMemory(
    embedding: number[],
    sector: SectorName,
    profileId: string,
    threshold: number,
  ): (MemoryRecord & { source?: string }) | null {
    const candidates = this.getRowsForSector(sector, profileId, SECTOR_SCAN_LIMIT);
    for (const row of candidates) {
      if (cosineSimilarity(embedding, row.embedding) >= threshold) {
        return row as MemoryRecord & { source?: string };
      }
    }
    return null;
  }

  /**
   * Find a near-duplicate procedural memory by trigger embedding similarity.
   */
  private findDuplicateProcedural(
    embedding: number[],
    profileId: string,
    threshold: number,
  ): (ProceduralMemoryRecord & { source?: string }) | null {
    const candidates = this.getProceduralRows(profileId, SECTOR_SCAN_LIMIT);
    for (const row of candidates) {
      if (cosineSimilarity(embedding, row.embedding) >= threshold) {
        return row as ProceduralMemoryRecord & { source?: string };
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

  private getCandidatesForSector(sector: SectorName, profileId: string, userId?: string): MemoryRecord[] {
    switch (sector) {
      case 'procedural':
        return this.getProceduralRows(profileId, SECTOR_SCAN_LIMIT, userId).map((r) => ({
          id: r.id,
          sector: 'procedural' as SectorName,
          content: r.trigger,
          embedding: r.embedding,
          profileId: r.profileId,
          createdAt: r.createdAt,
          lastAccessed: r.lastAccessed,
          details: { trigger: r.trigger, goal: r.goal, context: r.context, result: r.result, steps: r.steps },
        } as any));
      case 'semantic':
        return this.getSemanticRows(profileId, SECTOR_SCAN_LIMIT, userId).map((r) => ({
          id: r.id,
          sector: 'semantic' as SectorName,
          content: `${r.subject} ${r.predicate} ${r.object}`,
          embedding: r.embedding ?? [],
          profileId: r.profileId,
          createdAt: r.createdAt,
          lastAccessed: r.updatedAt,
          details: { subject: r.subject, predicate: r.predicate, object: r.object, validFrom: r.validFrom, validTo: r.validTo, domain: r.domain },
        } as any));
      case 'reflective':
        return this.getReflectiveRows(profileId, SECTOR_SCAN_LIMIT).map((r) => ({
          id: r.id,
          sector: 'reflective' as SectorName,
          content: r.observation,
          embedding: r.embedding,
          profileId: r.profileId,
          createdAt: r.createdAt,
          lastAccessed: r.lastAccessed,
        }));
      default:
        return this.getRowsForSector(sector, profileId, SECTOR_SCAN_LIMIT, userId);
    }
  }

  private getRowsForSector(sector: SectorName, profileId: string, limit: number, userId?: string): MemoryRecord[] {
    const userFilter = userId ? 'and (user_scope is null or user_scope = @userId)' : '';
    const rows = this.db.prepare(
      `select id, sector, content, embedding, created_at as createdAt, last_accessed as lastAccessed,
              event_start as eventStart, event_end as eventEnd, retrieval_count as retrievalCount, profile_id as profileId, source
       from memory
       where sector = @sector and profile_id = @profileId ${userFilter}
       order by last_accessed desc
       limit @limit`,
    ).all({ sector, limit, profileId, userId }) as Array<Omit<MemoryRecord, 'embedding'>>;

    return rows.map((row) => ({
      ...row,
      embedding: JSON.parse((row as any).embedding) as number[],
    }));
  }

  private getSemanticRows(profileId: string, limit: number, userId?: string): SemanticMemoryRecord[] {
    const now = this.now();
    const userFilter = userId ? 'and (user_scope is null or user_scope = @userId)' : '';
    const rows = this.db.prepare(
      `select id, subject, predicate, object, valid_from as validFrom, valid_to as validTo,
              created_at as createdAt, updated_at as updatedAt, embedding, metadata, profile_id as profileId,
              strength, domain
       from semantic_memory
       where profile_id = @profileId
         and (valid_to is null or valid_to > @now)
         ${userFilter}
       order by strength desc, updated_at desc
       limit @limit`,
    ).all({ limit, profileId, now, userId }) as any[];

    return rows.map((row: any) => ({
      ...row,
      embedding: JSON.parse(row.embedding) as number[],
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      strength: row.strength ?? 1.0,
    }));
  }

  private getProceduralRows(profileId: string, limit: number, userId?: string): ProceduralMemoryRecord[] {
    const userFilter = userId ? 'and (user_scope is null or user_scope = @userId)' : '';
    const rows = this.db.prepare(
      `select id, trigger, goal, context, result, steps, embedding, created_at as createdAt, last_accessed as lastAccessed, profile_id as profileId, source
       from procedural_memory
       where profile_id = @profileId ${userFilter}
       order by last_accessed desc
       limit @limit`,
    ).all({ limit, profileId, userId }) as Array<Omit<ProceduralMemoryRecord, 'embedding' | 'steps'>>;

    return rows.map((row) => ({
      ...row,
      steps: JSON.parse((row as any).steps) as string[],
      embedding: JSON.parse((row as any).embedding) as number[],
    }));
  }

  private touchRows(ids: string[], sector?: SectorName) {
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(',');
    const now = this.now();

    // Each sector lives in its own table
    const table =
      sector === 'procedural' ? 'procedural_memory'
        : sector === 'semantic' ? 'semantic_memory'
        : sector === 'reflective' ? 'reflective_memory'
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
          profile_id text not null default '${DEFAULT_PROFILE}'
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_memory_sector on memory(sector)').run();
    this.db.prepare('create index if not exists idx_memory_last_accessed on memory(last_accessed)').run();

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
          profile_id text not null default '${DEFAULT_PROFILE}'
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_proc_last_accessed on procedural_memory(last_accessed)').run();

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
          profile_id text not null default '${DEFAULT_PROFILE}'
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_semantic_subject_pred on semantic_memory(subject, predicate)').run();
    this.db.prepare('create index if not exists idx_semantic_object on semantic_memory(object)').run();

    // New tables
    this.db
      .prepare(
        `create table if not exists reflective_memory (
          id text primary key,
          observation text not null,
          embedding json not null,
          created_at integer not null,
          last_accessed integer not null,
          profile_id text not null default '${DEFAULT_PROFILE}',
          source text,
          origin_type text,
          origin_actor text,
          origin_ref text
        )`,
      )
      .run();
    this.db.prepare('create index if not exists idx_reflective_profile on reflective_memory(profile_id, last_accessed)').run();

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

    this.ensureProfileColumns();
    this.ensureProfileIndexes();
    this.ensureProfilesTable();
    this.ensureStrengthColumn();
    this.ensureSourceColumn();
    this.ensureAttributionColumns();
  }

  /**
   * Add strength column to semantic_memory if it doesn't exist.
   * Strength tracks evidence count from consolidation (starts at 1.0).
   */
  private ensureStrengthColumn() {
    const columns = this.db.prepare('PRAGMA table_info(semantic_memory)').all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === 'strength')) {
      this.db.prepare('ALTER TABLE semantic_memory ADD COLUMN strength REAL NOT NULL DEFAULT 1.0').run();
    }
    // Index for slot-based lookups (subject + predicate)
    this.db
      .prepare('CREATE INDEX IF NOT EXISTS idx_semantic_slot ON semantic_memory(subject, predicate, profile_id)')
      .run();
  }

  /**
   * Add source column to all 3 tables if it doesn't exist.
   * Stores the relative file path for document-ingested memories.
   */
  private ensureSourceColumn() {
    const tables = ['memory', 'procedural_memory', 'semantic_memory'];
    for (const table of tables) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'source')) {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN source TEXT DEFAULT NULL`).run();
      }
    }
  }

  /**
   * Add attribution and user_scope columns to all memory tables.
   * origin_type, origin_actor, origin_ref track where a memory came from.
   * user_scope limits visibility to a specific user.
   * domain on semantic_memory classifies facts.
   */
  private ensureAttributionColumns() {
    const tablesWithUserScope = ['memory', 'procedural_memory', 'semantic_memory'];
    for (const table of tablesWithUserScope) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === 'origin_type')) {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN origin_type TEXT DEFAULT NULL`).run();
      }
      if (!columns.some((c) => c.name === 'origin_actor')) {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN origin_actor TEXT DEFAULT NULL`).run();
      }
      if (!columns.some((c) => c.name === 'origin_ref')) {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN origin_ref TEXT DEFAULT NULL`).run();
      }
      if (!columns.some((c) => c.name === 'user_scope')) {
        this.db.prepare(`ALTER TABLE ${table} ADD COLUMN user_scope TEXT DEFAULT NULL`).run();
      }
    }

    // Domain column on semantic_memory only
    const semCols = this.db.prepare('PRAGMA table_info(semantic_memory)').all() as Array<{ name: string }>;
    if (!semCols.some((c) => c.name === 'domain')) {
      this.db.prepare("ALTER TABLE semantic_memory ADD COLUMN domain TEXT DEFAULT NULL").run();
    }

    // Indexes for user_scope filtering
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_memory_user_scope ON memory(user_scope)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_proc_user_scope ON procedural_memory(user_scope)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_semantic_user_scope ON semantic_memory(user_scope)').run();
    this.db.prepare('CREATE INDEX IF NOT EXISTS idx_semantic_domain ON semantic_memory(domain)').run();
  }

  /**
   * Find all active (non-expired) facts for a subject.
   * Used for semantic similarity matching during consolidation.
   */
  findActiveFactsForSubject(
    subject: string,
    profileId: string
  ): Array<{ id: string; predicate: string; object: string; updatedAt: number }> {
    const now = this.now();
    const rows = this.db
      .prepare(
        `SELECT id, predicate, object, updated_at as updatedAt
         FROM semantic_memory
         WHERE subject = @subject
           AND profile_id = @profileId
           AND (valid_to IS NULL OR valid_to > @now)
         ORDER BY updated_at DESC`
      )
      .all({ subject, profileId, now }) as Array<{ id: string; predicate: string; object: string; updatedAt: number }>;
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
   * Strengthen an existing semantic fact (merge operation).
   * Increases strength by delta and updates timestamp.
   */
  strengthenFact(id: string, delta: number = 1.0): void {
    this.db
      .prepare(
        `UPDATE semantic_memory
         SET strength = strength + @delta,
             updated_at = @now
         WHERE id = @id`
      )
      .run({ id, delta, now: this.now() });
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

  /**
   * Backfills profile_id column for existing databases and creates profile-aware indexes.
   */
  private ensureProfileColumns() {
    const tables = ['memory', 'procedural_memory', 'semantic_memory'];
    for (const table of tables) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const hasProfile = columns.some((c) => c.name === 'profile_id');
      if (!hasProfile) {
        this.db
          .prepare(`ALTER TABLE ${table} ADD COLUMN profile_id text not null default '${DEFAULT_PROFILE}'`)
          .run();
      }
    }
  }

  private ensureProfileIndexes() {
    this.db
      .prepare('create index if not exists idx_memory_profile_sector on memory(profile_id, sector, last_accessed)')
      .run();
    this.db
      .prepare('create index if not exists idx_proc_profile on procedural_memory(profile_id, last_accessed)')
      .run();
    this.db
      .prepare('create index if not exists idx_semantic_profile on semantic_memory(profile_id, updated_at)')
      .run();
  }

  private ensureProfilesTable() {
    this.db
      .prepare(
        `create table if not exists profiles (
          slug text primary key,
          created_at integer not null
        )`,
      )
      .run();

    this.ensureProfileExists(DEFAULT_PROFILE);

    // One-time backfill of existing profile ids into profiles table
    const now = this.now();
    const backfill = [
      'insert or ignore into profiles (slug, created_at) select distinct profile_id, @now from memory',
      'insert or ignore into profiles (slug, created_at) select distinct profile_id, @now from procedural_memory',
      'insert or ignore into profiles (slug, created_at) select distinct profile_id, @now from semantic_memory',
    ];
    for (const sql of backfill) {
      this.db.prepare(sql).run({ now });
    }
  }

  private ensureProfileExists(profileId: string) {
    this.db
      .prepare('insert or ignore into profiles (slug, created_at) values (@slug, @createdAt)')
      .run({ slug: profileId, createdAt: this.now() });
  }

  async updateById(id: string, content: string, sector?: SectorName, profile?: string): Promise<boolean> {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    // First, get the existing record to preserve sector if not changing
    const existing = this.db
      .prepare('select sector from memory where id = ? and profile_id = ?')
      .get(id, profileId) as { sector: SectorName } | undefined;

    if (!existing) {
      return false;
    }

    const targetSector = sector ?? existing.sector;

    // Regenerate embedding with new content
    const embedding = await this.embed(content, targetSector);

    // Update the record
    const stmt = this.db.prepare(
      'update memory set content = ?, sector = ?, embedding = json(?), last_accessed = ? where id = ? and profile_id = ?'
    );
    const res = stmt.run(
      content,
      targetSector,
      JSON.stringify(embedding),
      this.now(),
      id,
      profileId,
    );

    return res.changes > 0;
  }

  deleteById(id: string, profile?: string): number {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const res1 = this.db.prepare('delete from memory where id = ? and profile_id = ?').run(id, profileId);
    const res2 = this.db.prepare('delete from procedural_memory where id = ? and profile_id = ?').run(id, profileId);
    const res3 = this.db.prepare('delete from semantic_memory where id = ? and profile_id = ?').run(id, profileId);
    const res4 = this.db.prepare('delete from reflective_memory where id = ? and profile_id = ?').run(id, profileId);
    return (res1.changes ?? 0) + (res2.changes ?? 0) + (res3.changes ?? 0) + (res4.changes ?? 0);
  }

  deleteAll(profile?: string): number {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const res1 = this.db.prepare('delete from memory where profile_id = ?').run(profileId);
    const res2 = this.db.prepare('delete from procedural_memory where profile_id = ?').run(profileId);
    const res3 = this.db.prepare('delete from semantic_memory where profile_id = ?').run(profileId);
    const res4 = this.db.prepare('delete from reflective_memory where profile_id = ?').run(profileId);
    return (res1.changes ?? 0) + (res2.changes ?? 0) + (res3.changes ?? 0) + (res4.changes ?? 0);
  }

  deleteProfile(profile?: string): number {
    const profileId = normalizeProfileSlug(profile);
    if (profileId === DEFAULT_PROFILE) {
      throw new Error('cannot_delete_default_profile');
    }
    // Delete all memories for this profile
    const deletedCount = this.deleteAll(profileId);
    // Delete the profile itself from the profiles table
    const res = this.db.prepare('delete from profiles where slug = ?').run(profileId);
    // Delete agent_users entries for this profile
    this.db.prepare('delete from agent_users where agent_id = ?').run(profileId);
    return deletedCount;
  }

  deleteSemanticById(id: string, profile?: string): number {
    const profileId = normalizeProfileSlug(profile);
    this.ensureProfileExists(profileId);
    const res = this.db.prepare('delete from semantic_memory where id = ? and profile_id = ?').run(id, profileId);
    return res.changes ?? 0;
  }

  getAvailableProfiles(): string[] {
    const rows = this.db.prepare('select slug from profiles order by slug').all() as Array<{ slug: string }>;
    return rows.map((r) => r.slug);
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
}
