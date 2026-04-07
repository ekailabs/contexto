import { Mindmap, jsonFileStorage, memoryStorage } from '@ekai/mindmap';
import type { MindmapStorage } from '@ekai/mindmap';
import type { ContextoBackend, Logger, SearchResult, WebhookPayload } from '../types.js';
import type { LocalBackendConfig } from './types.js';
import { extractEpisodeText, summarizeEpisode } from './summarizer.js';

const DEFAULT_STORAGE_PATH = '.contexto/mindmap.json';

/** ContextoBackend implementation that runs the full pipeline locally. */
export class LocalBackend implements ContextoBackend {
  private mindmap: Mindmap;
  private config: LocalBackendConfig;
  private logger: Logger;

  constructor(config: LocalBackendConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    const storage: MindmapStorage = config.storage
      ?? jsonFileStorage(config.storagePath ?? DEFAULT_STORAGE_PATH);

    this.mindmap = new Mindmap({
      provider: config.provider,
      apiKey: config.apiKey,
      embedModel: config.embedModel,
      storage,
      config: config.mindmapConfig,
    });
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
          provider: this.config.provider,
          apiKey: this.config.apiKey,
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
        await this.mindmap.add(items);
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
    try {
      const result = await this.mindmap.search(query, {
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
