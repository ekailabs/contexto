export type SectorName = 'episodic' | 'semantic' | 'procedural' | 'reflective';

export type SemanticDomain = 'user' | 'world' | 'self';

export interface SemanticTripleInput {
  subject: string;
  predicate: string;
  object: string;
  domain?: SemanticDomain;
}

export interface ReflectiveInput {
  observation: string;
}

export interface MemoryOrigin {
  originType: 'conversation' | 'document' | 'api' | 'reflection';
  originActor?: string;   // userId or system identifier
  originRef?: string;      // conversation id, document path, etc.
}

export interface IngestComponents {
  episodic?: string;
  semantic?: SemanticTripleInput | SemanticTripleInput[];
  procedural?: string | {
    trigger: string;
    goal?: string;
    steps?: string[];
    result?: string;
    context?: string;
  };
  reflective?: ReflectiveInput | ReflectiveInput[];
}

export interface MemoryRecord {
  id: string;
  sector: SectorName;
  content: string;
  embedding: number[];
  profileId: string;
  createdAt: number;
  lastAccessed: number;
  eventStart?: number | null;
  eventEnd?: number | null;
  source?: string;
  originType?: string;
  originActor?: string;
  originRef?: string;
  userScope?: string | null;
}

export interface ProceduralMemoryRecord {
  id: string;
  trigger: string;
  profileId: string;
  goal?: string;
  context?: string;
  result?: string;
  steps: string[];
  embedding: number[];
  createdAt: number;
  lastAccessed: number;
  source?: string;
  originType?: string;
  originActor?: string;
  originRef?: string;
  userScope?: string | null;
}

export interface SemanticMemoryRecord {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  profileId: string;
  embedding: number[];
  validFrom: number;
  validTo: number | null;
  createdAt: number;
  updatedAt: number;
  strength: number;           // Evidence count from consolidation (starts at 1.0)
  source?: string;
  metadata?: Record<string, any>;
  domain?: SemanticDomain;
  originType?: string;
  originActor?: string;
  originRef?: string;
  userScope?: string | null;
}

export interface ReflectiveMemoryRecord {
  id: string;
  observation: string;
  profileId: string;
  embedding: number[];
  createdAt: number;
  lastAccessed: number;
  source?: string;
  originType?: string;
  originActor?: string;
  originRef?: string;
}

/**
 * Consolidation action for semantic facts
 */
export type ConsolidationAction =
  | { type: 'merge'; targetId: string }     // Same object exists: strengthen it
  | { type: 'supersede'; targetId: string } // Different object: close old, insert new
  | { type: 'insert' };                     // No existing fact for this slot

export interface QueryResult {
  sector: SectorName;
  id: string;
  profileId: string;
  content: string;
  score: number;
  similarity: number;
  decay: number;
  createdAt: number;
  lastAccessed: number;
}

export type EmbedFn = (input: string, sector: SectorName) => Promise<number[]>;

export interface GraphTraversalOptions {
  maxDepth?: number;
  maxResults?: number;
  includeInvalidated?: boolean;
  predicateFilter?: string;
  profile?: string;
}

export interface GraphPath {
  path: SemanticMemoryRecord[];
  depth: number;
}

export interface IngestOptions {
  source?: string;
  deduplicate?: boolean;
  origin?: MemoryOrigin;
  userId?: string;
}
