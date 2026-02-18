import { API_CONFIG } from './constants';

const API_BASE_URL = API_CONFIG.BASE_URL;
export const MEMORY_BASE_URL = API_CONFIG.MEMORY_URL;

// Types based on your backend response
export interface UsageRecord {
  id: number;
  request_id: string;
  provider: string;
  model: string;
  timestamp: string;
  input_tokens: number;
  cache_write_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_cost: number;
  cache_write_cost: number;
  cache_read_cost: number;
  output_cost: number;
  total_cost: number;
  currency: string;
  payment_method?: string;
  created_at: string;
}

export interface UsageResponse {
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  costByProvider: Record<string, number>;
  costByModel: Record<string, number>;
  records: UsageRecord[];
}

export interface ConfigStatusResponse {
  providers: Record<string, boolean>;
  mode: 'byok' | 'hybrid' | 'x402-only';
  hasApiKeys: boolean;
  x402Enabled: boolean;
  server: {
    environment: string;
    port: number;
  };
}

export interface ModelCatalogEntry {
  id: string;
  provider: string;
  endpoint: 'chat_completions' | 'messages' | 'responses';
  pricing: {
    input: number;
    output: number;
    cache_write?: number;
    cache_read?: number;
    currency: string;
    unit: string;
  } | null;
  source: string;
}

export interface ModelsResponse {
  total: number;
  limit: number;
  offset: number;
  items: ModelCatalogEntry[];
}

export interface BudgetResponse {
  amountUsd: number | null;
  alertOnly: boolean;
  window: 'monthly';
  spentMonthToDate: number;
  remaining: number | null;
}

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
  details?: {
    trigger?: string;
    goal?: string;
    context?: string;
    result?: string;
    steps?: string[];
  };
}

export interface MemorySummaryResponse {
  summary: MemorySectorSummary[];
  recent: MemoryRecentItem[];
}

// API service functions
export const apiService = {
  // Fetch usage data
  async getUsage(fromDate?: Date, toDate?: Date): Promise<UsageResponse> {
    let url = `${API_BASE_URL}/usage`;
    
    if (fromDate || toDate) {
      const params = new URLSearchParams();
      if (fromDate) {
        params.append('startTime', fromDate.toISOString());
      }
      if (toDate) {
        params.append('endTime', toDate.toISOString());
      }
      url += `?${params.toString()}`;
    }
    
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch usage data: ${response.statusText}`);
    }
    return response.json();
  },

  // Check health
  async getHealth() {
    const response = await fetch(`${API_BASE_URL}/health`);
    if (!response.ok) {
      throw new Error(`Failed to fetch health: ${response.statusText}`);
    }
    return response.json();
  },

  async downloadUsageCsv(fromDate?: Date, toDate?: Date) {
    const params = new URLSearchParams();
    if (fromDate) params.append('startTime', fromDate.toISOString());
    if (toDate) params.append('endTime', toDate.toISOString());
    params.append('format', 'csv');

    const url = `${API_BASE_URL}/usage?${params.toString()}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to export CSV: ${response.statusText}`);
    }

    const blob = await response.blob();
    const link = document.createElement('a');
    const downloadUrl = window.URL.createObjectURL(blob);
    link.href = downloadUrl;

    const startLabel = fromDate ? fromDate.toISOString().slice(0, 10) : 'start';
    const endLabel = toDate ? toDate.toISOString().slice(0, 10) : 'end';
    link.download = `usage-${startLabel}-${endLabel}.csv`;

    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(downloadUrl);
  },

  async getConfigStatus(): Promise<ConfigStatusResponse> {
    const response = await fetch(`${API_BASE_URL}/config/status`);
    if (!response.ok) {
      throw new Error(`Failed to fetch config status: ${response.statusText}`);
    }
    return response.json();
  },

  async getModels(params?: { provider?: string; endpoint?: 'chat_completions' | 'messages' | 'responses'; search?: string; limit?: number; offset?: number }): Promise<ModelsResponse> {
    const searchParams = new URLSearchParams();
    if (params?.provider) searchParams.append('provider', params.provider);
    if (params?.endpoint) searchParams.append('endpoint', params.endpoint);
    if (params?.search) searchParams.append('search', params.search);
    if (params?.limit) searchParams.append('limit', String(params.limit));
    if (params?.offset) searchParams.append('offset', String(params.offset));

    const url = `${API_BASE_URL}/v1/models${searchParams.toString() ? `?${searchParams.toString()}` : ''}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }
    return response.json();
  },

  async getBudget(): Promise<BudgetResponse> {
    const response = await fetch(`${API_BASE_URL}/budget`);
    if (!response.ok) {
      throw new Error(`Failed to fetch budget: ${response.statusText}`);
    }
    return response.json();
  },

  async updateBudget(payload: { amountUsd: number | null; alertOnly?: boolean }): Promise<BudgetResponse> {
    const response = await fetch(`${API_BASE_URL}/budget`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error(`Failed to update budget: ${response.statusText}`);
    }

    return response.json();
  },

  async getMemorySummary(limit = 50, profile?: string): Promise<MemorySummaryResponse> {
    const params = new URLSearchParams();
    params.append('limit', String(limit));
    if (profile) params.append('profile', profile);
    
    const response = await fetch(`${MEMORY_BASE_URL}/v1/summary?${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch memory summary: ${response.statusText}`);
    }
    return response.json();
  },

  async updateMemory(id: string, content: string, sector?: string, profile?: string): Promise<{ updated: boolean; id: string; profile?: string }> {
    const response = await fetch(`${MEMORY_BASE_URL}/v1/memory/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, sector, profile }),
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

  async deleteMemory(id: string, profile?: string): Promise<void> {
    const params = new URLSearchParams();
    if (profile) params.append('profile', profile);
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

  async deleteAllMemories(profile?: string): Promise<{ deleted: number; profile?: string }> {
    const params = new URLSearchParams();
    if (profile) params.append('profile', profile);
    const url = `${MEMORY_BASE_URL}/v1/memory${params.toString() ? `?${params.toString()}` : ''}`;

    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      throw new Error(`Failed to delete all memories: ${response.statusText}`);
    }
    return response.json();
  },

  // Graph traversal APIs
  async getGraphVisualization(params?: { entity?: string; maxDepth?: number; maxNodes?: number; profile?: string; includeHistory?: boolean }): Promise<{
    center?: string;
    nodes: Array<{ id: string; label: string }>;
    edges: Array<{ source: string; target: string; predicate: string; isHistorical?: boolean }>;
    includeHistory?: boolean;
  }> {
    const searchParams = new URLSearchParams();
    if (params?.entity) searchParams.append('entity', params.entity);
    if (params?.maxDepth) searchParams.append('maxDepth', String(params.maxDepth));
    if (params?.maxNodes) searchParams.append('maxNodes', String(params.maxNodes));
    if (params?.profile) searchParams.append('profile', params.profile);
    if (params?.includeHistory) searchParams.append('includeHistory', 'true');

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

  async getGraphNeighbors(entity: string): Promise<{ entity: string; neighbors: string[]; count: number }> {
    const response = await fetch(`${MEMORY_BASE_URL}/v1/graph/neighbors?entity=${encodeURIComponent(entity)}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch neighbors: ${response.statusText}`);
    }
    return response.json();
  },

  async getGraphPaths(from: string, to: string, maxDepth?: number): Promise<{
    from: string;
    to: string;
    paths: Array<{ path: Array<{ subject: string; predicate: string; object: string }>; depth: number }>;
    count: number;
  }> {
    const searchParams = new URLSearchParams();
    searchParams.append('from', from);
    searchParams.append('to', to);
    if (maxDepth) searchParams.append('maxDepth', String(maxDepth));

    const response = await fetch(`${MEMORY_BASE_URL}/v1/graph/paths?${searchParams.toString()}`);
    if (!response.ok) {
      throw new Error(`Failed to fetch paths: ${response.statusText}`);
    }
    return response.json();
  },

  async getProfiles(): Promise<{ profiles: string[] }> {
    const response = await fetch(`${MEMORY_BASE_URL}/v1/profiles`);
    if (!response.ok) {
      throw new Error(`Failed to fetch profiles: ${response.statusText}`);
    }
    return response.json();
  },

  async deleteProfile(profile: string): Promise<{ deleted: number; profile: string }> {
    const response = await fetch(`${MEMORY_BASE_URL}/v1/profiles/${encodeURIComponent(profile)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      // Treat "not_found" as a no-op to keep the flow idempotent
      if (response.status === 404 && body?.error === 'not_found') {
        return { deleted: 0, profile };
      }
      const reason = body?.error === 'default_profile_protected'
        ? 'Default profile cannot be deleted'
        : body?.error ?? response.statusText;
      throw new Error(`Failed to delete profile: ${reason}`);
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
