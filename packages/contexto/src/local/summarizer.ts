import type { WebhookPayload, ContentBlock, Logger } from '../types.js';
import { stripMetadataEnvelope } from '../helpers.js';
import type { EpisodeSummary, LLMProviderConfig } from './types.js';

const LLM_PROVIDERS: Record<string, { baseUrl: string; defaultModel: string }> = {
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openai/gpt-4o-mini',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
  },
};

const SUMMARIZE_SYSTEM_PROMPT = `You are a concise summarizer. Given a conversation episode (user question + assistant answer + tool outputs), produce a JSON object with exactly these fields:

{
  "status": "complete" | "partial" | "blocked",
  "summary": "<concise one-paragraph summary of what happened in this episode>",
  "key_findings": ["<finding 1>", "<finding 2>", ...],
  "evidence_refs": [{"type": "<episode_ref|tool_ref|file_ref|trace_ref>", "value": "<reference>"}],
  "open_questions": ["<optional unresolved question>"],
  "confidence": <0.0 to 1.0>
}

Rules:
- Set status to "complete" if the episode fully resolved the user's request, "partial" if only partly, "blocked" if unable to proceed.
- summary should be 1-3 sentences capturing the essence.
- key_findings should have at least one entry.
- evidence_refs should reference relevant tools, files, or episodes mentioned.
- Respond ONLY with valid JSON, no markdown fences, no extra text.`;

/** Extract text content from a message, handling both string and ContentBlock[] formats. */
function extractMessageText(message: any): string {
  if (!message) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as ContentBlock[])
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => block.text)
      .join('\n');
  }
  return '';
}

/**
 * Extract combined text from an episode/combined WebhookPayload.
 * Returns empty string for non-episode events.
 */
export function extractEpisodeText(payload: WebhookPayload): string {
  if (payload.event.type !== 'episode' || payload.event.action !== 'combined') {
    return '';
  }

  const data = payload.data as Record<string, any> | undefined;
  if (!data) return '';

  const parts: string[] = [];

  // User message — strip OpenClaw metadata envelope
  const userText = extractMessageText(data.userMessage);
  if (userText) {
    parts.push(`Q: ${stripMetadataEnvelope(userText)}`);
  }

  // Assistant messages (drop api/usage/model metadata)
  const assistantMessages = Array.isArray(data.assistantMessages) ? data.assistantMessages : [];
  for (const msg of assistantMessages) {
    const text = extractMessageText(msg);
    if (text) parts.push(`A: ${text}`);
  }

  return parts.join('\n');
}

/**
 * Summarize episode text via an LLM call.
 * Returns a graceful fallback on any failure.
 */
export async function summarizeEpisode(
  text: string,
  config: LLMProviderConfig,
  logger: Logger,
): Promise<EpisodeSummary> {
  const providerDef = LLM_PROVIDERS[config.provider];
  if (!providerDef) {
    logger.warn(`[contexto:local] Unknown LLM provider: ${config.provider}, using fallback summary`);
    return buildFallback(text);
  }

  const model = config.model ?? providerDef.defaultModel;
  const url = `${providerDef.baseUrl}/chat/completions`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SUMMARIZE_SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      logger.warn(`[contexto:local] LLM summarize HTTP ${response.status}: ${body.slice(0, 200)}`);
      return buildFallback(text);
    }

    const json = await response.json() as any;
    const raw = json.choices?.[0]?.message?.content;
    if (!raw) {
      logger.warn('[contexto:local] LLM returned no content, using fallback summary');
      return buildFallback(text);
    }

    return parseSummary(raw, text, logger);
  } catch (err) {
    logger.warn(`[contexto:local] LLM summarize failed: ${err instanceof Error ? err.message : String(err)}`);
    return buildFallback(text);
  }
}

/** Parse and validate LLM JSON response into EpisodeSummary, with graceful degradation. */
function parseSummary(raw: string, originalText: string, logger: Logger): EpisodeSummary {
  try {
    const parsed = JSON.parse(raw);

    const summary = typeof parsed.summary === 'string' && parsed.summary
      ? parsed.summary
      : originalText.slice(0, 200);

    const key_findings = Array.isArray(parsed.key_findings) && parsed.key_findings.length > 0
      ? parsed.key_findings.map(String)
      : ['Episode processed'];

    const status = ['complete', 'partial', 'blocked'].includes(parsed.status)
      ? parsed.status as EpisodeSummary['status']
      : 'partial';

    const confidence = typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1
      ? parsed.confidence
      : 0.5;

    const evidence_refs = Array.isArray(parsed.evidence_refs)
      ? parsed.evidence_refs.filter((r: any) => r && typeof r.type === 'string' && typeof r.value === 'string')
      : [];

    const open_questions = Array.isArray(parsed.open_questions)
      ? parsed.open_questions.filter((q: any) => typeof q === 'string')
      : undefined;

    return { summary, key_findings, status, confidence, evidence_refs, open_questions };
  } catch (err) {
    logger.warn(`[contexto:local] Failed to parse LLM summary JSON: ${err instanceof Error ? err.message : String(err)}`);
    return buildFallback(originalText);
  }
}

/** Build a fallback EpisodeSummary from raw text when LLM call or parsing fails. */
function buildFallback(text: string): EpisodeSummary {
  return {
    summary: text.slice(0, 200) + (text.length > 200 ? '...' : ''),
    key_findings: ['Episode processed (fallback — LLM summarization unavailable)'],
    status: 'partial',
    confidence: 0.0,
    evidence_refs: [],
  };
}
