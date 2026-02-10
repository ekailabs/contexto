/**
 * Centralized application configuration
 * All environment variables are validated and accessed through this class
 */

export class AppConfig {
  // Server configuration
  readonly server = {
    port: this.getNumber('PORT', 3001),
    environment: this.getString('NODE_ENV', 'development'),
    isDevelopment: this.getString('NODE_ENV', 'development') === 'development',
    isProduction: this.getString('NODE_ENV', 'development') === 'production',
    version: this.getOptionalString('npm_package_version') || 'dev',
  };

  // x402 Payment configuration
  readonly x402 = {
    enabled: this.has('PRIVATE_KEY'),
    privateKey: this.getOptionalString('PRIVATE_KEY'),
    baseUrl: this.getString('X402_BASE_URL', 'https://x402.ekailabs.xyz'),
    
    // Helper methods
    get chatCompletionsUrl() {
      return `${this.baseUrl}/v1/chat/completions`;
    },
    get messagesUrl() {
      return `${this.baseUrl}/v1/messages`;
    },
  };

  // Provider API Keys
  readonly providers = {
    anthropic: {
      apiKey: this.getOptionalString('ANTHROPIC_API_KEY'),
      enabled: this.has('ANTHROPIC_API_KEY'),
    },
    openai: {
      apiKey: this.getOptionalString('OPENAI_API_KEY'),
      enabled: this.has('OPENAI_API_KEY'),
    },
    openrouter: {
      apiKey: this.getOptionalString('OPENROUTER_API_KEY'),
      enabled: this.has('OPENROUTER_API_KEY'),
    },
    xai: {
      apiKey: this.getOptionalString('XAI_API_KEY'),
      enabled: this.has('XAI_API_KEY'),
    },
    zai: {
      apiKey: this.getOptionalString('ZAI_API_KEY'),
      enabled: this.has('ZAI_API_KEY'),
    },
    google: {
      apiKey: this.getOptionalString('GOOGLE_API_KEY'),
      enabled: this.has('GOOGLE_API_KEY'),
    },
    ollama: {
      baseUrl: this.getString('OLLAMA_BASE_URL', 'http://localhost:11434/v1'),
      apiKey: this.getOptionalString('OLLAMA_API_KEY'),
      enabled: this.has('OLLAMA_BASE_URL'),
    },
  };

  // Telemetry configuration
  readonly telemetry = {
    enabled: this.getBoolean('ENABLE_TELEMETRY', true),
    endpoint: this.getOptionalString('TELEMETRY_ENDPOINT'),
  };

  // OpenRouter-specific configuration
  readonly openrouter = {
    skipPricingRefresh: this.getBoolean('SKIP_OPENROUTER_PRICING_REFRESH', false),
    pricingTimeoutMs: this.getNumber('OPENROUTER_PRICING_TIMEOUT_MS', 4000),
    pricingRetries: this.getNumber('OPENROUTER_PRICING_RETRIES', 2),
  };

  // Feature flags
  readonly features = {
    usageTracking: this.getBoolean('ENABLE_USAGE_TRACKING', true),
  };

  readonly oauth = {
    openai: {
      clientId: this.getString('OPENAI_OAUTH_CLIENT_ID', ''),
      enabled: this.has('OPENAI_OAUTH_CLIENT_ID'),
    },
    anthropic: {
      enabled: true,
    },
  };

  readonly memory = {
    backend: this.getString('MEMORY_BACKEND', 'file'),
    maxItems: this.getNumber('MEMORY_MAX_ITEMS', 20),
  } as const;

  // Helper methods
  private has(key: string): boolean {
    return !!process.env[key];
  }

  private getString(key: string, defaultValue: string): string;
  private getString(key: string): string;
  private getString(key: string, defaultValue?: string): string {
    const value = process.env[key] || defaultValue;
    if (value === undefined) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
    return value;
  }

  private getOptionalString(key: string): string | undefined {
    return process.env[key];
  }

  private getNumber(key: string, defaultValue: number): number {
    const value = process.env[key];
    if (!value) return defaultValue;
    const num = parseInt(value, 10);
    if (isNaN(num)) {
      throw new Error(`Invalid number for environment variable ${key}: ${value}`);
    }
    return num;
  }

  private getBoolean(key: string, defaultValue: boolean): boolean {
    const value = process.env[key];
    if (!value) return defaultValue;
    return value.toLowerCase() === 'true' || value === '1';
  }

  /**
   * Validate that at least one authentication method is configured
   */
  validate(): void {
    const hasApiKeys = Object.values(this.providers).some(p => p.enabled);
    const hasX402 = this.x402.enabled;
    const hasOAuth = this.oauth.openai.enabled || this.oauth.anthropic.enabled;

    if (!hasApiKeys && !hasX402 && !hasOAuth) {
      throw new Error(
        'No authentication configured. Set either:\n' +
        '  1. At least one provider API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)\n' +
        '  2. PRIVATE_KEY for x402 payment mode\n' +
        '  3. OAuth configuration (OPENAI_OAUTH_CLIENT_ID)'
      );
    }
  }

  /**
   * Get human-readable mode description
   */
  getMode(): 'x402-only' | 'hybrid' | 'byok' {
    const hasApiKeys = Object.values(this.providers).some(p => p.enabled);
    const hasX402 = this.x402.enabled;

    if (!hasApiKeys && hasX402) return 'x402-only';
    if (hasApiKeys && hasX402) return 'hybrid';
    return 'byok';
  }
}

// Singleton instance
let configInstance: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!configInstance) {
    configInstance = new AppConfig();
    configInstance.validate();
  }
  return configInstance;
}

// For testing - reset config
export function resetConfig(): void {
  configInstance = null;
}

