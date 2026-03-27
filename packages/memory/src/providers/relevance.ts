import { resolveProvider, getApiKey, getModel, buildUrl } from './registry.js';

const RELEVANCE_SYSTEM = `You are a relevance filter. The user will provide text from a conversation.
You must decide if this text is relevant to the agent's memory scope described below.

AGENT RELEVANCE CRITERIA:
{RELEVANCE_PROMPT}

Respond with JSON only: { "relevant": true/false, "reason": "brief explanation" }
If unsure, lean toward relevant (true).`;

export async function checkRelevance(
  text: string,
  relevancePrompt: string,
): Promise<{ relevant: boolean; reason: string }> {
  try {
    const cfg = resolveProvider('extract');
    const apiKey = getApiKey(cfg);
    const model = getModel(cfg, 'extract');
    const { url, headers } = buildUrl(cfg, 'extract', model, apiKey);

    const systemPrompt = RELEVANCE_SYSTEM.replace('{RELEVANCE_PROMPT}', relevancePrompt);

    if (cfg.name === 'gemini') {
      const resp = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${text}` }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json' },
        }),
      });
      if (!resp.ok) throw new Error(`gemini relevance failed: ${resp.status}`);
      const json = (await resp.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      const content = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      const parsed = JSON.parse(content);
      return { relevant: !!parsed.relevant, reason: parsed.reason ?? '' };
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`openai relevance failed: ${resp.status}`);
    const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
    const content = json.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(content);
    return { relevant: !!parsed.relevant, reason: parsed.reason ?? '' };
  } catch (_) {
    // Fail-open: if relevance check errors, proceed with ingestion
    return { relevant: true, reason: 'filter_error' };
  }
}
