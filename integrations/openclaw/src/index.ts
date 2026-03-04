import { EventWriter } from './store';

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

    // --- Helper: extract IDs from context by hook type ---

    function ids(event: any, ctx: any) {
      return {
        sessionId: ctx?.sessionKey ?? ctx?.sessionId ?? ctx?.conversationId ?? undefined,
        agentId: ctx?.agentId ?? undefined,
        userId: event?.from ?? ctx?.userId ?? undefined,
        conversationId: ctx?.conversationId ?? undefined,
      };
    }

    function subagentIds(_event: any, ctx: any) {
      return {
        sessionId: ctx?.childSessionKey ?? ctx?.requesterSessionKey ?? undefined,
        agentId: ctx?.agentId ?? undefined,
      };
    }

    function gatewayIds() {
      return { sessionId: undefined, agentId: undefined };
    }

    // --- Fire-and-forget observe helper ---

    function observe(hookName: string, event: any, ctx: any, idExtractor: (e: any, c: any) => any = ids) {
      const extracted = idExtractor(event, ctx);
      void store.append({
        hook: hookName,
        sessionId: extracted.sessionId,
        agentId: extracted.agentId,
        userId: extracted.userId,
        conversationId: extracted.conversationId,
        event: event ?? {},
        ctx: ctx ? { ...ctx } : undefined,
      }).catch((err) => api.logger.warn(`claw-contexto: ${hookName}: ${String(err)}`));
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

    // Tool hooks (modifying, return void — observe only)
    api.on('before_tool_call', (event: any, ctx: any) => { observe('before_tool_call', event, ctx); });
    api.on('after_tool_call', (event: any, ctx: any) => { observe('after_tool_call', event, ctx); });

    // --- Sync hooks (must be non-async — OpenClaw ignores Promise results) ---
    api.on('tool_result_persist', (event: any, ctx: any) => { observe('tool_result_persist', event, ctx); });
    api.on('before_message_write', (event: any, ctx: any) => { observe('before_message_write', event, ctx); });

    // --- Subagent hooks ---
    api.on('subagent_spawning', (event: any, ctx: any) => { observe('subagent_spawning', event, ctx, subagentIds); });
    api.on('subagent_delivery_target', (event: any, ctx: any) => { observe('subagent_delivery_target', event, ctx, subagentIds); });
    api.on('subagent_spawned', (event: any, ctx: any) => { observe('subagent_spawned', event, ctx, subagentIds); });
    api.on('subagent_ended', (event: any, ctx: any) => { observe('subagent_ended', event, ctx, subagentIds); });

    // --- Gateway hooks ---
    api.on('gateway_start', (event: any, ctx: any) => { observe('gateway_start', event, ctx, gatewayIds); });

    // --- Flush hooks (async — await write + flush before shutdown) ---

    api.on('agent_end', async (event: any, ctx: any) => {
      const extracted = ids(event, ctx);
      try {
        await store.append({
          hook: 'agent_end',
          sessionId: extracted.sessionId,
          agentId: extracted.agentId,
          userId: extracted.userId,
          conversationId: extracted.conversationId,
          event: event ?? {},
          ctx: ctx ? { ...ctx } : undefined,
        });
        await store.flush();
      } catch (err) {
        api.logger.warn(`claw-contexto: agent_end: ${String(err)}`);
      }
    });

    api.on('gateway_stop', async (event: any, ctx: any) => {
      const extracted = gatewayIds();
      try {
        await store.append({
          hook: 'gateway_stop',
          sessionId: extracted.sessionId,
          agentId: extracted.agentId,
          event: event ?? {},
          ctx: ctx ? { ...ctx } : undefined,
        });
        await store.flush();
      } catch (err) {
        api.logger.warn(`claw-contexto: gateway_stop: ${String(err)}`);
      }
    });

    api.logger.info(`claw-contexto: storing events to ${dataDir}`);
  },
};
