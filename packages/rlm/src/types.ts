/** Chat message for LLM interactions. */
export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Context that can be passed to the RLM tools — any large text or structured data. */
export type Context = string | Record<string, unknown> | unknown[];

/**
 * Abstraction over LLM completion — injected by the consumer.
 * Wire this to pi-ai, OpenAI, Anthropic, or any LLM SDK.
 */
export interface CompletionProvider {
  /** Chat completion from a list of messages. */
  completion(messages: Message[]): Promise<string>;
  /** Simple completion from a single string prompt. */
  completionStr(prompt: string): Promise<string>;
}
