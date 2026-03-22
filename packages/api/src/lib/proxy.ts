import { Request, Response } from 'express';
import crypto from 'crypto';
import { logUsage } from '../services/api-key.service.js';

// OpenRouter pricing (approximate, in cents per 1M tokens)
// Update these with actual prices from OpenRouter
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'anthropic/claude-3.5-sonnet': { input: 150, output: 600 }, // $1.50/m input, $6.00/m output
  'anthropic/claude-3-opus': { input: 750, output: 2250 },
  'anthropic/claude-3-haiku': { input: 25, output: 65 },
  'openai/gpt-4o': { input: 250, output: 750 },
  'openai/gpt-4o-mini': { input: 15, output: 60 },
  'google/gemini-pro': { input: 35, output: 70 },
  'meta-llama/llama-3.1-70b': { input: 40, output: 40 },
};

// Default pricing for unknown models
const DEFAULT_PRICING = { input: 50, output: 100 };

function getModelPricing(model: string): { input: number; output: number } {
  // Check for exact match or partial match
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (model.includes(key) || key.includes(model)) {
      return pricing;
    }
  }
  return DEFAULT_PRICING;
}

function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = getModelPricing(model);
  
  // Convert to cents (input/output are per 1M tokens)
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  
  return Math.round(inputCost + outputCost);
}

export async function proxyToOpenRouter(req: Request, res: Response, keyId: string, userId: string) {
  const body = req.body;
  const model = body.model || 'unknown';
  
  // Track if we've started streaming
  let startedStreaming = false;
  let inputTokens = 0;
  let outputTokens = 0;
  
  // Capture response tokens from streaming
  const originalWrite = res.write.bind(res);
  const chunks: Buffer[] = [];
  
  res.write = function(chunk: Buffer, encoding?: any): boolean {
    chunks.push(chunk);
    
    // Try to parse token counts from chunks (OpenRouter sends usage in final chunk)
    try {
      const text = chunk.toString();
      if (text.includes('"usage"')) {
        const usageMatch = text.match(/"usage"\s*:\s*\{([^}]+)\}/);
        if (usageMatch) {
          const inputMatch = usageMatch[1].match(/"prompt_tokens"\s*:\s*(\d+)/);
          const outputMatch = usageMatch[1].match(/"completion_tokens"\s*:\s*(\d+)/);
          
          if (inputMatch) inputTokens = parseInt(inputMatch[1], 10);
          if (outputMatch) outputTokens = parseInt(outputMatch[1], 10);
        }
      }
    } catch (e) {
      // Ignore parse errors during streaming
    }
    
    startedStreaming = true;
    return originalWrite(chunk, encoding);
  };
  
  try {
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    
    if (!openrouterKey) {
      return res.status(500).json({ error: 'OpenRouter API key not configured' });
    }
    
    // Forward request to OpenRouter
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${openrouterKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.APP_URL || 'https://getcontexto.com',
        'X-Title': 'Contexto',
      },
      body: JSON.stringify({
        ...body,
        // Don't expose user's API key to OpenRouter
      }),
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('[proxy] OpenRouter error:', response.status, errorText);
      return res.status(response.status).json({
        error: 'OpenRouter request failed',
        message: errorText,
      });
    }
    
    // Handle streaming vs non-streaming
    const contentType = response.headers.get('content-type') || '';
    
    if (contentType.includes('text/event-stream')) {
      // Stream the response
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      for await (const chunk of response.body as any) {
        res.write(chunk);
      }
      
      res.end();
    } else {
      // Non-streaming - parse response
      const responseData = await response.json();
      
      // Extract token usage from response
      if (responseData.usage) {
        inputTokens = responseData.usage.prompt_tokens || 0;
        outputTokens = responseData.completion_tokens || 0;
      }
      
      // Send response to client
      res.status(response.status).json(responseData);
    }
    
    // Log usage after request completes
    if (startedStreaming || inputTokens > 0 || outputTokens > 0) {
      const costCents = calculateCost(model, inputTokens, outputTokens);
      
      await logUsage(keyId, model, inputTokens, outputTokens, costCents);
      console.log(`[usage] key=${keyId.slice(0,8)} model=${model} in=${inputTokens} out=${outputTokens} cost=${costCents}c`);
    }
    
  } catch (error) {
    console.error('[proxy] error:', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Proxy error',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}