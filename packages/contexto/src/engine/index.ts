import type { ContextoBackend, Logger, PluginConfig } from '../types.js';
import { createCompactionState } from './types.js';
import { DefaultContextEngine } from './default.js';
import { SlidingWindowEngine } from './sliding-window.js';

export { AbstractContextEngine } from './base.js';
export { DefaultContextEngine } from './default.js';
export { SlidingWindowEngine } from './sliding-window.js';
export * from './types.js';
export * from './utils.js';

/** Create the context engine for the given strategy. */
export function createContextEngine(config: PluginConfig, backend: ContextoBackend, logger: Logger) {
  const state = createCompactionState();

  return config.compactionStrategy === 'default'
    ? new DefaultContextEngine(state, config, backend, logger)
    : new SlidingWindowEngine(state, config, backend, logger);
}
