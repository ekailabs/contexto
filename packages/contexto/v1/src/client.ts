import type { ContextoBackend, Logger, PluginConfig, SearchResult, WebhookPayload } from './types.js';

const API_BASE = 'https://api.getcontexto.com';

/** ContextoBackend implementation that calls the hosted Contexto API. */
export class RemoteBackend implements ContextoBackend {
  private headers: Record<string, string>;

  constructor(config: PluginConfig, private logger: Logger) {
    this.headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    };
  }

  /** Send a conversation event to the webhooks API for storage. */
  async ingest(payload: WebhookPayload): Promise<void> {
    try {
      const response = await fetch(`${API_BASE}/v1/webhooks/events`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '(no body)');
        this.logger.warn(`[contexto] webhook HTTP ${response.status}: ${response.statusText} — body: ${body}`);
      } else {
        this.logger.info(`[contexto] webhook OK ${response.status} for ${payload.event.type}:${payload.event.action}`);
      }
    } catch (err) {
      this.logger.warn(`[contexto] webhook failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Query the mindmap search API (multi-branch beam search). */
  async search(query: string, sessionKey: string, maxResults: number, filter?: Record<string, unknown>): Promise<SearchResult | null> {
    try {
      const response = await fetch(`${API_BASE}/v1/mindmap/search`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ query, maxResults, filter }),
      });

      if (response.ok) {
        return await response.json() as SearchResult;
      }

      const body = await response.text().catch(() => '');
      this.logger.warn(`[contexto] /v1/mindmap/search HTTP ${response.status}: ${body.slice(0, 200)}`);
      return null;
    } catch (err) {
      this.logger.warn(`[contexto] /v1/mindmap/search failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
