import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ConversationMessage {
  role: string;
  content: string;
}

interface ConversationLogEntry {
  id: string;
  ts: number;
  agentId: string;
  userId?: string;
  messages: ConversationMessage[];
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((part: any) => part?.type === 'text' && typeof part?.text === 'string')
      .map((part: any) => part.text.trim())
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

export function normalizeMessages(messages: unknown): ConversationMessage[] {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((msg: any) => ({
      role: typeof msg?.role === 'string' ? msg.role : 'user',
      content: normalizeMessageContent(msg?.content),
    }))
    .filter((msg) => msg.content.length > 0);
}

export function appendConversationLog(
  logPath: string,
  input: { agentId: string; userId?: string; messages: ConversationMessage[] },
): void {
  if (!input.messages.length) return;

  const entry: ConversationLogEntry = {
    id: randomUUID(),
    ts: Date.now(),
    agentId: input.agentId,
    userId: input.userId,
    messages: input.messages,
  };

  const line = `${JSON.stringify(entry)}\n`;
  setImmediate(async () => {
    try {
      await mkdir(dirname(logPath), { recursive: true });
      await appendFile(logPath, line, 'utf8');
    } catch (err: any) {
      console.warn(`[conversation-log] failed to append: ${err.message}`);
    }
  });
}
