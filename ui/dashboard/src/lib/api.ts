import { API_CONFIG } from './constants';

export const MEMORY_BASE_URL = API_CONFIG.MEMORY_URL;

export interface MemorySectorSummary {
  sector: 'episodic' | 'semantic' | 'procedural' | 'reflective';
  count: number;
  lastCreatedAt: number | null;
}

export interface MemoryRecentItem {
  id: string;
  sector: 'episodic' | 'semantic' | 'procedural' | 'reflective';
  createdAt: number;
  lastAccessed: number;
  preview: string;
  retrievalCount?: number;
  userScope?: string | null;
  source?: string | null;
  details?: {
    trigger?: string;
    goal?: string;
    context?: string;
    result?: string;
    steps?: string[];
    domain?: string;
  };
}

export interface MemorySummaryResponse {
  summary: MemorySectorSummary[];
  recent: MemoryRecentItem[];
}

// API service functions
export const apiService = {
  async getMemorySummary(limit = 50, agent?: string): Promise<MemorySummaryResponse> {
    const params = new URLSearchParams();
    params.append('limit', String(limit));
    if (agent) params.append('agent', agent);

    const response = await fetch(`${MEMORY_BASE_URL}/v1/summary?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch memory summary: ${response.statusText}`);
    }
    return response.json();
  },

  async updateMemory(id: string, content: string, sector?: string, agent?: string, userScope?: string | null): Promise<{ updated: boolean; id: string; agent?: string }> {
    const body: Record<string, string | null | undefined> = { content, sector, agent };
    if (userScope !== undefined) {
      body.userScope = userScope;
    }
    const response = await fetch(`${MEMORY_BASE_URL}/v1/memory/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      let errorMessage = `Failed to update memory: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = `Failed to update memory: ${errorData.error}`;
        }
      } catch {
        // If response is not JSON, use statusText
      }
      throw new Error(errorMessage);
    }
    return response.json();
  },

  async deleteMemory(id: string, agent?: string): Promise<void> {
    const params = new URLSearchParams();
    if (agent) params.append('agent', agent);
    const url = `${MEMORY_BASE_URL}/v1/memory/${encodeURIComponent(id)}${params.toString() ? `?${params.toString()}` : ''}`;

    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      let errorMessage = `Failed to delete memory: ${response.statusText}`;
      try {
        const errorData = await response.json();
        if (errorData.error) {
          errorMessage = `Failed to delete memory: ${errorData.error}`;
        }
      } catch {
        // If response is not JSON, use statusText
      }
      throw new Error(errorMessage);
    }
  },

  async deleteAllMemories(agent?: string): Promise<{ deleted: number; agent?: string }> {
    const params = new URLSearchParams();
    if (agent) params.append('agent', agent);
    const url = `${MEMORY_BASE_URL}/v1/memory${params.toString() ? `?${params.toString()}` : ''}`;

    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      throw new Error(`Failed to delete all memories: ${response.statusText}`);
    }
    return response.json();
  },

  // Graph traversal APIs
  async getGraphVisualization(params?: { entity?: string; maxDepth?: number; maxNodes?: number; agent?: string; includeHistory?: boolean; userId?: string }): Promise<{
    center?: string;
    nodes: Array<{ id: string; label: string }>;
    edges: Array<{ source: string; target: string; predicate: string; isHistorical?: boolean }>;
    includeHistory?: boolean;
  }> {
    const searchParams = new URLSearchParams();
    if (params?.entity) searchParams.append('entity', params.entity);
    if (params?.maxDepth) searchParams.append('maxDepth', String(params.maxDepth));
    if (params?.maxNodes) searchParams.append('maxNodes', String(params.maxNodes));
    if (params?.agent) searchParams.append('agent', params.agent);
    if (params?.includeHistory) searchParams.append('includeHistory', 'true');
    if (params?.userId) searchParams.append('userId', params.userId);

    const url = `${MEMORY_BASE_URL}/v1/graph/visualization${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch graph visualization: ${response.statusText}`);
    }
    return response.json();
  },

  async getGraphTriples(params: { entity: string; direction?: 'incoming' | 'outgoing' | 'both'; maxResults?: number; predicate?: string }): Promise<{
    entity: string;
    triples: Array<{
      id: string;
      subject: string;
      predicate: string;
      object: string;
      validFrom: number;
      validTo: number | null;
    }>;
    count: number;
  }> {
    const searchParams = new URLSearchParams();
    searchParams.append('entity', params.entity);
    if (params.direction) searchParams.append('direction', params.direction);
    if (params.maxResults) searchParams.append('maxResults', String(params.maxResults));
    if (params.predicate) searchParams.append('predicate', params.predicate);

    const url = `${MEMORY_BASE_URL}/v1/graph/triples?${searchParams.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch graph triples: ${response.statusText}`);
    }
    return response.json();
  },

  async getAgents(): Promise<{ agents: Array<{ id: string; name: string; createdAt: number }> }> {
    const response = await fetch(`${MEMORY_BASE_URL}/v1/agents`);
    if (!response.ok) {
      throw new Error(`Failed to fetch agents: ${response.statusText}`);
    }
    return response.json();
  },

  async getUsers(agent: string): Promise<{ users: Array<{ userId: string; firstSeen: number; lastSeen: number; interactionCount: number }>; agent: string }> {
    const response = await fetch(`${MEMORY_BASE_URL}/v1/users?agent=${encodeURIComponent(agent)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch users: ${response.statusText}`);
    }
    return response.json();
  },

  async deleteAgent(agent: string): Promise<{ deleted: number; agent: string }> {
    const response = await fetch(`${MEMORY_BASE_URL}/v1/agents/${encodeURIComponent(agent)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      // Treat "not_found" as a no-op to keep the flow idempotent
      if (response.status === 404 && body?.error === 'not_found') {
        return { deleted: 0, agent };
      }
      const reason = body?.error === 'default_agent_protected'
        ? 'Default agent cannot be deleted'
        : body?.error ?? response.statusText;
      throw new Error(`Failed to delete agent: ${reason}`);
    }
    return response.json();
  },

  async deleteGraphTriple(id: string): Promise<{ deleted: number }> {
    const response = await fetch(`${MEMORY_BASE_URL}/v1/graph/triple/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error(`Failed to delete triple: ${response.statusText}`);
    }
    return response.json();
  }
};
