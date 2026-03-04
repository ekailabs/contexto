import { appendFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import {
  SCHEMA_VERSION,
  REDACTED_KEYS,
  sanitizeId,
  safeStringify,
  todayDate,
  toolParamsFingerprint,
  resolveConversationKey,
  CorrelationCache,
  ToolCallTracker,
  type RouteKind,
  type RouteResult,
  type AppendInput,
} from './routing';

// --- EventWriter (conversation-first routing) ---

class EventWriter {
  private chains = new Map<string, Promise<void>>();

  constructor(private dataDir: string) {}

  async append(input: AppendInput): Promise<void> {
    const id = input.id ?? randomUUID();
    const eventTs = input.ts ?? Date.now();
    const ingestTs = Date.now();

    const storeEvent: Record<string, unknown> = {
      id,
      v: SCHEMA_VERSION,
      eventTs,
      ingestTs,
      hook: input.hook,
      conversationKey: input.conversationKey,
      routeKind: input.routeKind,
      routeReason: input.routeReason,
      userId: input.userId,
      event: input.event,
      ctx: input.ctx,
    };

    if (input._dedupTracked) {
      storeEvent._dedupTracked = true;
    }

    let line: string;
    try {
      line = safeStringify(storeEvent);
    } catch {
      line = JSON.stringify({
        id,
        v: SCHEMA_VERSION,
        eventTs,
        ingestTs,
        hook: input.hook,
        conversationKey: input.conversationKey,
        routeKind: input.routeKind,
        event: {},
        _error: 'serialization failed',
      });
    }

    const { dir, filePath } = this.resolvePath(input.routeKind ?? 'orphan', input.conversationKey ?? 'unknown');

    const prev = this.chains.get(filePath) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(() => this.writeLine(dir, filePath, line));
    this.chains.set(filePath, next);

    next
      .then(() => {
        if (this.chains.get(filePath) === next) this.chains.delete(filePath);
      })
      .catch(() => {
        if (this.chains.get(filePath) === next) this.chains.delete(filePath);
      });

    return next;
  }

  async flush(): Promise<void> {
    await Promise.all(this.chains.values());
  }

  private resolvePath(routeKind: RouteKind, conversationKey: string): { dir: string; filePath: string } {
    const date = todayDate();
    switch (routeKind) {
      case 'conversation': {
        const dir = join(this.dataDir, 'conversations');
        const filePath = join(dir, `${sanitizeId(conversationKey)}.jsonl`);
        return { dir, filePath };
      }
      case 'system': {
        const dir = join(this.dataDir, 'system');
        const filePath = join(dir, `system-${date}.jsonl`);
        return { dir, filePath };
      }
      case 'orphan': {
        const dir = join(this.dataDir, 'orphans');
        const filePath = join(dir, `orphan-${date}.jsonl`);
        return { dir, filePath };
      }
    }
  }

  private async writeLine(dir: string, filePath: string, line: string): Promise<void> {
    await mkdir(dir, { recursive: true });
    await appendFile(filePath, line + '\n');
  }
}

// --- Plugin definition ---

export default {
  id: 'claw-contexto',
  name: 'Ekai Contexto',
  description: 'Context engine for OpenClaw — captures lifecycle events for memory and analytics',
  configSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      dataDir: { type: 'string' },
    },
  },

  register(api: any) {
    const dataDir = api.resolvePath(api.pluginConfig?.dataDir ?? '~/.openclaw/ekai/data');
    const store = new EventWriter(dataDir);
    const cache = new CorrelationCache();

    // --- Emit helper: writes a single event to the store ---

    function emit(event: any, ctx: any, route: RouteResult, userId?: string, deduped?: boolean) {
      void store.append({
        hook: ctx?._hookName ?? 'unknown',
        event: event ?? {},
        ctx: ctx ? { ...ctx } : undefined,
        conversationKey: route.conversationKey,
        routeKind: route.routeKind,
        routeReason: route.routeReason,
        userId,
        _dedupTracked: deduped,
      }).catch((err) => api.logger.warn(`claw-contexto: ${ctx?._hookName ?? 'unknown'}: ${String(err)}`));
    }

    const toolDedup = new ToolCallTracker(emit);

    // --- Unified observe helper ---

    function observe(hookName: string, event: any, ctx: any, overrideKind?: 'system') {
      const userId = event?.from ?? ctx?.userId ?? undefined;
      const ctxWithHook = ctx ? { ...ctx, _hookName: hookName } : { _hookName: hookName };

      if (overrideKind === 'system') {
        const route: RouteResult = {
          conversationKey: `system-${todayDate()}`,
          routeKind: 'system',
          routeReason: 'system-hook',
        };
        emit(event, ctxWithHook, route, userId);
        return;
      }

      const route = resolveConversationKey(event, ctx, cache);

      if (hookName === 'before_tool_call') {
        const fp = toolParamsFingerprint(event);
        if (fp && route.routeKind === 'conversation') {
          cache.seedToolCall(fp, route.conversationKey);
        }
      }

      if (hookName === 'after_tool_call') {
        let finalRoute = route;
        if (route.routeKind === 'orphan') {
          const fp = toolParamsFingerprint(event);
          if (fp) {
            const cached = cache.lookupToolCall(fp);
            if (cached) {
              finalRoute = {
                conversationKey: cached,
                routeKind: 'conversation',
                routeReason: 'toolCall-cached-afterRetry',
              };
            }
          }
        }
        toolDedup.receive(event, ctxWithHook, finalRoute, userId);
        return;
      }

      emit(event, ctxWithHook, route, userId);
    }

    // --- Session hooks ---
    api.on('session_start', (event: any, ctx: any) => { observe('session_start', event, ctx); });
    api.on('session_end', (event: any, ctx: any) => { observe('session_end', event, ctx); });

    // --- Message hooks ---
    api.on('message_received', (event: any, ctx: any) => { observe('message_received', event, ctx); });
    api.on('message_sending', (event: any, ctx: any) => { observe('message_sending', event, ctx); });
    api.on('message_sent', (event: any, ctx: any) => { observe('message_sent', event, ctx); });

    // --- Agent hooks ---
    api.on('llm_input', (event: any, ctx: any) => { observe('llm_input', event, ctx); });
    api.on('llm_output', (event: any, ctx: any) => { observe('llm_output', event, ctx); });
    api.on('before_compaction', (event: any, ctx: any) => { observe('before_compaction', event, ctx); });
    api.on('after_compaction', (event: any, ctx: any) => { observe('after_compaction', event, ctx); });
    api.on('before_reset', (event: any, ctx: any) => { observe('before_reset', event, ctx); });

    // Agent (modifying, return void — observe only)
    api.on('before_model_resolve', (event: any, ctx: any) => { observe('before_model_resolve', event, ctx); });
    api.on('before_prompt_build', (event: any, ctx: any) => { observe('before_prompt_build', event, ctx); });
    api.on('before_agent_start', (event: any, ctx: any) => { observe('before_agent_start', event, ctx); });

    // Tool hooks
    api.on('before_tool_call', (event: any, ctx: any) => { observe('before_tool_call', event, ctx); });
    api.on('after_tool_call', (event: any, ctx: any) => { observe('after_tool_call', event, ctx); });

    // --- Sync hooks ---
    api.on('tool_result_persist', (event: any, ctx: any) => { observe('tool_result_persist', event, ctx); });
    api.on('before_message_write', (event: any, ctx: any) => { observe('before_message_write', event, ctx); });

    // --- Subagent hooks ---
    api.on('subagent_spawning', (event: any, ctx: any) => { observe('subagent_spawning', event, ctx); });
    api.on('subagent_delivery_target', (event: any, ctx: any) => { observe('subagent_delivery_target', event, ctx); });
    api.on('subagent_spawned', (event: any, ctx: any) => { observe('subagent_spawned', event, ctx); });
    api.on('subagent_ended', (event: any, ctx: any) => { observe('subagent_ended', event, ctx); });

    // --- Gateway hooks (system stream) ---
    api.on('gateway_start', (event: any, ctx: any) => { observe('gateway_start', event, ctx, 'system'); });

    // --- Flush hooks (async — await write + flush before shutdown) ---

    api.on('agent_end', async (event: any, ctx: any) => {
      try {
        const userId = event?.from ?? ctx?.userId ?? undefined;
        const ctxWithHook = ctx ? { ...ctx, _hookName: 'agent_end' } : { _hookName: 'agent_end' };
        const route = resolveConversationKey(event, ctx, cache);
        await store.append({
          hook: 'agent_end',
          event: event ?? {},
          ctx: ctxWithHook,
          conversationKey: route.conversationKey,
          routeKind: route.routeKind,
          routeReason: route.routeReason,
          userId,
        });
        toolDedup.flush();
        await store.flush();
      } catch (err) {
        api.logger.warn(`claw-contexto: agent_end: ${String(err)}`);
      }
    });

    api.on('gateway_stop', async (event: any, ctx: any) => {
      try {
        const route: RouteResult = {
          conversationKey: `system-${todayDate()}`,
          routeKind: 'system',
          routeReason: 'system-hook',
        };
        await store.append({
          hook: 'gateway_stop',
          event: event ?? {},
          ctx: ctx ? { ...ctx, _hookName: 'gateway_stop' } : { _hookName: 'gateway_stop' },
          conversationKey: route.conversationKey,
          routeKind: route.routeKind,
          routeReason: route.routeReason,
        });
        toolDedup.flush();
        await store.flush();
      } catch (err) {
        api.logger.warn(`claw-contexto: gateway_stop: ${String(err)}`);
      }
    });

    api.logger.info(`claw-contexto: storing events to ${dataDir}`);
  },
};
