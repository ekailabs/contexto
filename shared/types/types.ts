export interface ChatCompletionRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  model: string;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  [key: string]: any;
}

export interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}


export type ProviderName = 'openai' | 'openrouter' | 'anthropic' | 'ollama';

// Removed conversation types - no conversation storage

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AnthropicMessagesRequest {
  model: string;
  messages: Array<{ 
    role: 'user' | 'assistant'; 
    content: string | Array<{ type: string; text: string; }>; 
  }>;
  max_tokens?: number; // Make optional since Claude Code might not send it
  system?: string | Array<{ type: string; text: string; }>; // Can be string or array
  temperature?: number;
  stream?: boolean;
  [key: string]: any;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{
    type: 'text';
    text: string;
  }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';
  stop_sequence?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}