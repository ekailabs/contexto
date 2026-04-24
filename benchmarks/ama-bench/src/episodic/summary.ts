// Ported from ekailabs-api-server/src/services/api/summary.service.ts
//
// Adapted for the benchmark:
//   - Plain factory (no singleton, no env-driven init)
//   - Takes baseUrl/model/apiKey from config instead of OpenRouter hardcoded
//   - summarizeTurn(item, episodeId, turnIndex) replaces summarizeEpisode
//   - episode metadata shape replaced with simpler `turn` shape
//
// SYSTEM_PROMPT is kept byte-identical to production so benchmark results
// reflect the same LLM behavior that ships in ekailabs-api-server.

import type { EpisodeSummary, TurnData } from './types.js';
import { validateSummary, toDegradedSummary } from './validation.js';

const SYSTEM_PROMPT = `You are a concise summarizer. Given a conversation episode (user question + assistant answer + tool outputs), produce a JSON object with exactly these fields:

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

export interface SummarizerConfig {
  baseUrl: string;              // e.g. https://api.openai.com/v1/chat/completions  OR  http://localhost:8002/v1/chat/completions
  model: string;                // e.g. gpt-4o-mini, Qwen/Qwen3-32B
  apiKey?: string;              // optional for local VLLM (any value accepted)
  temperature?: number;         // default 0.2
  jsonMode?: boolean;           // default true — disable for VLLM backends without guided decoding
  noThink?: boolean;            // default false — if true, appends '/no_think' to user message (Qwen3 hybrid-reasoning models only)
}

export interface ConversationItemInput {
  id: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ConversationItemOutput {
  id: string;
  role: string;
  content: string;
  embedding: number[];
  timestamp: string;
  metadata: Record<string, unknown>;
}

export interface Summarizer {
  summarizeTurn(
    item: ConversationItemInput,
    episodeId: string,
    turnIndex: number,
  ): Promise<ConversationItemOutput>;
}

export function createSummarizer(config: SummarizerConfig): Summarizer {
  const temperature = config.temperature ?? 0.2;
  const jsonMode = config.jsonMode ?? true;
  const noThink = config.noThink ?? false;
  const apiKey = config.apiKey ?? 'EMPTY'; // VLLM accepts any token; OpenAI requires a real key
  console.log(
    `[episodic] initialized model=${config.model} baseUrl=${config.baseUrl} jsonMode=${jsonMode} noThink=${noThink}`,
  );

  async function callLLM(content: string): Promise<unknown> {
    // For Qwen3 hybrid-reasoning models, append /no_think to skip the thinking phase
    const userContent = noThink ? `${content}\n\n/no_think` : content;
    const body: Record<string, unknown> = {
      model: config.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature,
    };
    if (jsonMode) body.response_format = { type: 'json_object' };

    const response = await fetch(config.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '(no body)');
      throw new Error(`summarizer HTTP ${response.status}: ${body.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('Empty LLM response');

    // Strip Qwen3 reasoning blocks if present, then markdown code fences
    const stripped = text
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    return JSON.parse(stripped);
  }

  return {
    async summarizeTurn(
      item: ConversationItemInput,
      episodeId: string,
      turnIndex: number,
    ): Promise<ConversationItemOutput> {
      const traceRef = crypto.randomUUID();
      const turn: TurnData = {
        episodeId,
        turnIndex,
        role: item.role,
        rawContent: item.content,
      };

      let summary: EpisodeSummary;
      try {
        const raw = await callLLM(item.content);
        const { valid, failures } = validateSummary(raw);

        if (valid) {
          const r = raw as {
            summary: string;
            key_findings: string[];
            status: EpisodeSummary['metadata']['status'];
            evidence_refs: EpisodeSummary['metadata']['evidence_refs'];
            open_questions?: string[];
            confidence?: number;
          };
          summary = {
            id: crypto.randomUUID(),
            summary: r.summary,
            key_findings: r.key_findings,
            metadata: {
              status: r.status,
              evidence_refs: r.evidence_refs,
              open_questions: r.open_questions,
              confidence: r.confidence,
              trace_ref: traceRef,
              turn,
            },
            timestamp: new Date().toISOString(),
          };
        } else {
          summary = toDegradedSummary(raw, failures, traceRef, turn);
        }
      } catch (err) {
        console.error(
          '[episodic] LLM call failed:',
          err instanceof Error ? err.message : err,
        );
        summary = toDegradedSummary(null, ['llm_call_failed'], traceRef, turn);
      }

      // Build ConversationItem for the mindmap — identical shape to production:
      // content = summary + "\nKey findings:\n- ..."
      const contentParts = [summary.summary];
      if (summary.key_findings.length > 0) {
        contentParts.push(
          `\nKey findings:\n${summary.key_findings.map((f) => `- ${f}`).join('\n')}`,
        );
      }

      return {
        id: summary.id,
        role: 'assistant',
        content: contentParts.join('\n'),
        embedding: [],
        timestamp: summary.timestamp,
        metadata: {
          source: 'summary',
          ...summary.metadata,
          // Preserve original item id + any pre-existing metadata (e.g. turnIndex from Python)
          original_id: item.id,
          original_metadata: item.metadata ?? {},
        },
      };
    },
  };
}
