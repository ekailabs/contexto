import { homedir } from 'node:os';
import { join } from 'node:path';
import { Mindmap, jsonFileStorage } from '@ekai/mindmap';
import type { ContextoBackend, Logger, SearchResult, WebhookPayload } from '../types.js';
import type { LocalBackendConfig, ResolvedCredentials } from './types.js';
import { extractEpisodeText, summarizeEpisode } from './summarizer.js';

const STORAGE_PATH = join(homedir(), '.openclaw', 'data', 'contexto', 'mindmap.json');

/** ContextoBackend implementation that runs the full pipeline locally. */
export class LocalBackend implements ContextoBackend {
  private config: LocalBackendConfig;
  private logger: Logger;
  private mindmapPromise: Promise<Mindmap | null> | null = null;

  constructor(config: LocalBackendConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
  }

  /** Resolve credentials and build the Mindmap on first use, caching the result. */
  private async getMindmap(): Promise<Mindmap | null> {
    if (!this.mindmapPromise) {
      this.mindmapPromise = this.initMindmap();
    }
    return this.mindmapPromise;
  }

  private async initMindmap(): Promise<Mindmap | null> {
    let creds: ResolvedCredentials | null;
    try {
      creds = typeof this.config.credentials === 'function'
        ? await this.config.credentials()
        : this.config.credentials;
    } catch (err) {
      this.logger.warn(`[contexto:local] Credential resolution failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    if (!creds?.apiKey) {
      this.logger.warn('[contexto:local] No API key available — local backend disabled');
      return null;
    }

    const storage = this.config.storage ?? jsonFileStorage(STORAGE_PATH);

    return new Mindmap({
      provider: creds.provider,
      apiKey: creds.apiKey,
      embedModel: this.config.embedModel,
      storage,
      config: this.config.mindmapConfig,
    });
  }

  private async getCredentials(): Promise<ResolvedCredentials | null> {
    try {
      return typeof this.config.credentials === 'function'
        ? await this.config.credentials()
        : this.config.credentials;
    } catch {
      return null;
    }
  }

  async ingest(payload: WebhookPayload | WebhookPayload[]): Promise<void> {
    const payloads = Array.isArray(payload) ? payload : [payload];
    if (payloads.length === 0) return;

    // Filter to episode/combined events only
    const episodes = payloads.filter(
      (p) => p.event.type === 'episode' && p.event.action === 'combined',
    );

    if (episodes.length === 0) {
      this.logger.debug('[contexto:local] No episode/combined events to ingest');
      return;
    }

    const mindmap = await this.getMindmap();
    if (!mindmap) return;

    const creds = await this.getCredentials();
    if (!creds) return;

    try {
      const items: Array<{ id: string; role: string; content: string; timestamp?: string; metadata?: Record<string, unknown> }> = [];

      for (const ep of episodes) {
        const text = extractEpisodeText(ep);
        if (!text) {
          this.logger.debug('[contexto:local] Empty episode text, skipping');
          continue;
        }

        const traceRef = crypto.randomUUID();
        const summary = await summarizeEpisode(text, {
          provider: creds.provider,
          apiKey: creds.apiKey,
          model: this.config.llmModel,
        }, this.logger);

        // Compose content: summary + key findings as bullets (matches remote API format)
        const contentParts = [summary.summary];
        if (summary.key_findings.length > 0) {
          contentParts.push(`\nKey findings:\n${summary.key_findings.map((f) => `- ${f}`).join('\n')}`);
        }

        const episodeData = ep.data as Record<string, any> | undefined;

        items.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: contentParts.join('\n'),
          timestamp: ep.timestamp ?? new Date().toISOString(),
          metadata: {
            source: 'summary',
            status: summary.status,
            evidence_refs: summary.evidence_refs,
            open_questions: summary.open_questions,
            confidence: summary.confidence,
            trace_ref: traceRef,
            sessionKey: ep.sessionKey,
            episode: {
              userMessage: episodeData?.userMessage,
              assistantMessages: episodeData?.assistantMessages ?? [],
              toolMessages: episodeData?.toolMessages ?? [],
            },
          },
        });
      }

      if (items.length > 0) {
        await mindmap.add(items);
        this.logger.info(`[contexto:local] Ingested ${items.length} episode(s) into mindmap`);
      }
    } catch (err) {
      this.logger.warn(`[contexto:local] Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async search(
    query: string,
    maxResults: number,
    filter?: Record<string, unknown>,
    minScore?: number,
  ): Promise<SearchResult | null> {
    const mindmap = await this.getMindmap();
    if (!mindmap) return null;

    try {
      const result = await mindmap.search(query, {
        maxResults,
        filter,
        minScore,
      });

      if (!result.items.length) return null;

      return {
        items: result.items,
        paths: result.paths,
      };
    } catch (err) {
      this.logger.warn(`[contexto:local] Search failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}
