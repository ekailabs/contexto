import { WebhookPayload } from "./types.js";

// OpenClaw wraps user messages as: "Sender (untrusted metadata):\n```json\n{...}\n```\n\nActual text"
const METADATA_ENVELOPE_RE = /^Sender\s*\(untrusted metadata\)\s*:\s*```json\s*[\s\S]*?```\s*/i;

/** Strip the OpenClaw metadata envelope prefix, returning just the user's text. */
export function stripMetadataEnvelope(text: string): string {
  return text.replace(METADATA_ENVELOPE_RE, '').trim();
}

/** Format mindmap search result items into a context string with metadata. */
export function formatSearchResults(items: any[]): string {
  const formatted = items
    .map((r: any) => {
      const item = r.item ?? r;
      const meta = item.metadata ?? {};

      if (meta.source !== 'summary') {
        return `- ${item.content}`;
      }

      const parts: string[] = [item.content];

      if (Array.isArray(meta.evidence_refs) && meta.evidence_refs.length > 0) {
        const refs = meta.evidence_refs
          .map((ref: any) => `${ref.type}:${ref.value}`)
          .join(', ');
        parts.push(`Refs: ${refs}`);
      }

      if (meta.trace_ref) {
        parts.push(`Trace: ${meta.trace_ref}`);
      }

      const header = [meta.status, meta.confidence != null ? `confidence: ${meta.confidence}` : null]
        .filter(Boolean).join(' | ');

      const body = parts.join('\n');
      return header ? `### [${header}]\n${body}` : body;
    })
    .join('\n\n');

  return `## Relevant Context\n\n${formatted}`;
}

/** Wrap context string in a synthetic message pair and prepend to the original messages. */
export function assembleContextMessages(
  context: string,
  messages: any[],
): { messages: any[]; estimatedTokens: number } {
  const assembled = [
    { role: 'user', content: [{ type: 'text', text: '[Recalled context from previous conversations]' }] },
    { role: 'assistant', content: [{ type: 'text', text: context }] },
    ...messages,
  ];

  return { messages: assembled, estimatedTokens: Math.ceil(context.length / 4) };
}

/** Construct a webhook payload with a timestamp. */
export function buildPayload(
  type: string,
  action: string,
  sessionKey: string,
  context: Record<string, unknown>,
  agent?: Record<string, unknown>,
  data?: Record<string, unknown>,
): WebhookPayload {
  return {
    event: { type, action },
    sessionKey,
    timestamp: new Date().toISOString(),
    context,
    agent,
    data,
  };
}