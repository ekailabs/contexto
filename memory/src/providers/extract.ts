import type { IngestComponents, SemanticTripleInput } from '../types.js';
import { EXTRACT_PROMPT } from './prompt.js';
import { buildUrl, getApiKey, getModel, resolveProvider } from './registry.js';

/**
 * Normalize semantic output: single object → array, filter invalid triples.
 */
function normalizeSemantic(raw: any): SemanticTripleInput[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter(
    (t: any) =>
      t &&
      typeof t === 'object' &&
      typeof t.subject === 'string' && t.subject.trim() &&
      typeof t.predicate === 'string' && t.predicate.trim() &&
      typeof t.object === 'string' && t.object.trim(),
  ).map((t: any) => ({
    subject: t.subject.trim(),
    predicate: t.predicate.trim(),
    object: t.object.trim(),
    domain: ['user', 'world', 'self'].includes(t.domain) ? t.domain : 'world',
  }));
}

function parseResponse(parsed: any): IngestComponents {
  const semantic = normalizeSemantic(parsed.semantic);

  return {
    episodic: typeof parsed.episodic === 'string' ? parsed.episodic : '',
    semantic: semantic.length ? semantic : [],
    procedural: parsed.procedural ?? '',
  };
}

export async function extract(text: string): Promise<IngestComponents> {
  const cfg = resolveProvider('extract');
  const apiKey = getApiKey(cfg);
  const model = getModel(cfg, 'extract');
  const { url, headers } = buildUrl(cfg, 'extract', model, apiKey);

  if (cfg.name === 'gemini') {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${EXTRACT_PROMPT}\n\n${text}` }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
    });
    if (!resp.ok) {
      const b = await resp.text();
      throw new Error(`gemini extract failed: ${resp.status} ${b}`);
    }
    const json = (await resp.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const content = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    return parseResponse(JSON.parse(content));
  }

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!resp.ok) {
    const b = await resp.text();
    throw new Error(`openai extract failed: ${resp.status} ${b}`);
  }
  const json = (await resp.json()) as { choices: Array<{ message: { content: string } }> };
  const content = json.choices[0]?.message?.content ?? '{}';
  return parseResponse(JSON.parse(content));
}
