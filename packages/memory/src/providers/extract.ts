import type { ExtractFn, IngestComponents, ProviderName, SemanticTripleInput } from '../types.js';
import { EXTRACT_PROMPT } from './prompt.js';
import { PROVIDERS, buildUrl, getApiKey, getModel, resolveProvider, type ProviderConfig } from './registry.js';

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

/** Build the system-style instruction. If userId is provided, prime the model
 *  ABOVE the base prompt with the user's identity so first-person references
 *  ("I", "my", "User") get rewritten to that id when the model reads the
 *  conversation. Putting this first matters: the base prompt's own examples
 *  use bare names like "Sha", and an appended hint is too weak to override
 *  them on smaller/faster models like gemini-2.5-flash.
 */
function buildPrompt(userId?: string): string {
  if (!userId) return EXTRACT_PROMPT;
  const id = userId.trim();
  if (!id) return EXTRACT_PROMPT;
  // Light primer that explains what the speaker label means. The heavy lifting
  // is done by labelSourceText() which rewrites "User:" → "${id}:" in the
  // conversation itself — that's how the base prompt's "use the person's name"
  // rule gets a name to anchor to without depending on the model following
  // appended override-instructions (which gemini-2.5-flash often ignores).
  return (
    `In the conversation below, "${id}" is the user. Use "${id}" as the triple subject ` +
    `for any first-person facts the user states about themselves.\n\n` +
    EXTRACT_PROMPT
  );
}

/** Rewrite the source-text speaker label so the user's name appears literally
 *  in the conversation. Replaces the plain "User:" prefix produced by
 *  router.ts / memory.ts with "${userId}:". Returns text unchanged when no
 *  userId is set.
 */
export function labelSourceText(text: string, userId?: string): string {
  if (!userId) return text;
  const id = userId.trim();
  if (!id) return text;
  // Only replace the line-leading "User: " label that router/memory generates.
  // Don't touch substrings inside the message content itself.
  return text.replace(/^User: /gm, `${id}: `);
}

async function callExtract(
  cfg: ProviderConfig,
  model: string,
  apiKey: string,
  text: string,
  userId?: string,
): Promise<IngestComponents> {
  const { url, headers } = buildUrl(cfg, 'extract', model, apiKey);
  const prompt = buildPrompt(userId);
  const labeledText = labelSourceText(text, userId);

  if (cfg.name === 'gemini') {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: `${prompt}\n\n${labeledText}` }] }],
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
        { role: 'system', content: prompt },
        { role: 'user', content: labeledText },
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

/** Env-based extract (legacy). Resolves provider from MEMORY_EXTRACT_PROVIDER env var.
 *  Pass `userId` to anchor first-person triple subjects to a known identity.
 */
export async function extract(text: string, userId?: string): Promise<IngestComponents> {
  const cfg = resolveProvider('extract');
  const apiKey = getApiKey(cfg);
  const model = getModel(cfg, 'extract');
  return callExtract(cfg, model, apiKey, text, userId);
}

/** Factory: create an ExtractFn from explicit provider config. */
export function createExtractFn(opts: { provider: ProviderName; apiKey: string; extractModel?: string }): ExtractFn {
  const cfg = PROVIDERS[opts.provider];
  const model = opts.extractModel ?? cfg.defaultExtractModel;
  const apiKey = opts.apiKey;
  return (text: string, userId?: string) => callExtract(cfg, model, apiKey, text, userId);
}
