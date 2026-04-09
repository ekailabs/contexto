import { complete, getModel } from '@mariozechner/pi-ai';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { CompletionProvider, Message } from '@ekai/rlm';

export interface PiAiProviderConfig {
  provider: string;
  modelId: string;
  apiKey: string;
}

/**
 * Creates a CompletionProvider backed by pi-ai's complete() function.
 * Uses OpenClaw's model registry and auth — no external API clients.
 */
export function createPiAiCompletionProvider(config: PiAiProviderConfig): CompletionProvider {
  const model = getModel(config.provider as any, config.modelId as any) as Model<Api>;

  return {
    async completion(messages: Message[]): Promise<string> {
      let systemPrompt: string | undefined;
      const piMessages: Array<{ role: 'user'; content: string; timestamp: number }> = [];

      for (const m of messages) {
        if (m.role === 'system') {
          systemPrompt = systemPrompt ? `${systemPrompt}\n${m.content}` : m.content;
        } else {
          piMessages.push({
            role: 'user',
            content: m.content,
            timestamp: Date.now(),
          });
        }
      }

      const result = await complete(
        model,
        { systemPrompt, messages: piMessages as any },
        { apiKey: config.apiKey },
      );

      const textParts = result.content
        .filter((block: any) => block.type === 'text')
        .map((block: any) => block.text);

      if (textParts.length === 0) {
        throw new Error('No text content in LLM response');
      }

      return textParts.join('');
    },

    async completionStr(prompt: string): Promise<string> {
      return this.completion([{ role: 'user', content: prompt }]);
    },
  };
}
