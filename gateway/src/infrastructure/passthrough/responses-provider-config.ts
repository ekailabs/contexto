import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { logger } from '../utils/logger.js';
import { ResponsesPassthroughConfig, ResponsesAuthConfig } from './responses-passthrough.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CATALOG_PATH = path.join(__dirname, '../../../../model_catalog/responses_providers_v1.json');

interface RawResponsesProviderCatalog {
  providers: RawResponsesProviderEntry[];
}

interface RawResponsesProviderEntry {
  provider: string;
  models?: string[];
  responses: RawResponsesConfig;
}

interface RawResponsesConfig {
  base_url: string;
  auth?: RawResponsesAuthConfig;
  static_headers?: Record<string, string>;
  supported_client_formats: string[];
}

interface RawResponsesAuthConfig {
  env_var: string;
  header: string;
  scheme?: string;
  template?: string;
}

export interface ResponsesProviderDefinition {
  provider: string;
  config: ResponsesPassthroughConfig;
}

function toAuthConfig(raw?: RawResponsesAuthConfig): ResponsesAuthConfig | undefined {
  if (!raw) return undefined;
  return {
    envVar: raw.env_var,
    header: raw.header,
    scheme: raw.scheme,
    template: raw.template,
  };
}

function toDefinition(raw: RawResponsesProviderEntry): ResponsesProviderDefinition {
  return {
    provider: raw.provider,
    config: {
      provider: raw.provider,
      baseUrl: raw.responses.base_url,
      auth: toAuthConfig(raw.responses.auth),
      staticHeaders: raw.responses.static_headers,
      supportedClientFormats: raw.responses.supported_client_formats,
    },
  };
}

export function loadResponsesProviderDefinitions(): ResponsesProviderDefinition[] {
  if (!fs.existsSync(CATALOG_PATH)) {
    logger.warn('Responses providers catalog not found', {
      path: CATALOG_PATH,
      module: 'responses-provider-config',
    });
    return [];
  }

  try {
    const rawContent = fs.readFileSync(CATALOG_PATH, 'utf-8');
    const parsed = JSON.parse(rawContent) as RawResponsesProviderCatalog;

    if (!Array.isArray(parsed.providers)) {
      logger.error('Invalid responses providers catalog structure', {
        path: CATALOG_PATH,
        module: 'responses-provider-config',
      });
      return [];
    }

    return parsed.providers.map(toDefinition);
  } catch (error) {
    logger.error('Failed to load responses providers catalog', error, {
      path: CATALOG_PATH,
      module: 'responses-provider-config',
    });
    return [];
  }
}

const modelToProviderCache = new Map<string, string>();

function buildModelToProviderMap(): Map<string, string> {
  if (modelToProviderCache.size > 0) return modelToProviderCache;
  try {
    const rawContent = fs.readFileSync(CATALOG_PATH, 'utf-8');
    const parsed = JSON.parse(rawContent) as RawResponsesProviderCatalog;
    if (!Array.isArray(parsed.providers)) return modelToProviderCache;
    for (const entry of parsed.providers) {
      const models = entry.models || [];
      for (const model of models) {
        modelToProviderCache.set(model.toLowerCase(), entry.provider);
      }
    }
  } catch {}
  return modelToProviderCache;
}

export function getResponsesProviderForModel(model: string): string {
  const normalized = model.toLowerCase().trim();
  const map = buildModelToProviderMap();
  const provider = map.get(normalized);
  if (provider) return provider;
  if (normalized.includes('grok')) return 'xai';
  if (['llama', 'gemma', 'qwen', 'deepseek', 'phi', 'mistral', 'mixtral', 'codellama', 'starcoder'].some(p => normalized.includes(p))) return 'ollama';
  return 'openai';
}
