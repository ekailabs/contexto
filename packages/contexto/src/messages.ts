import type { Message } from './types.js';

// OpenClaw wraps user messages as: "Sender (untrusted metadata):\n```json\n{...}\n```\n\nActual text"
const METADATA_ENVELOPE_RE = /^Sender\s*\(untrusted metadata\)\s*:\s*```json\s*[\s\S]*?```\s*/i;

/** Strip the OpenClaw metadata envelope prefix, returning just the user's text. */
export function stripMetadataEnvelope(text: string): string {
  return text.replace(METADATA_ENVELOPE_RE, '').trim();
}

/** Extract the last user message text, stripping any metadata envelope. */
export function lastUserMessage(messages: Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== 'user') continue;

    let text = '';
    if (typeof m.content === 'string') {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = m.content
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join(' ');
    }

    text = stripMetadataEnvelope(text);
    if (text.trim()) return text;
  }
}
