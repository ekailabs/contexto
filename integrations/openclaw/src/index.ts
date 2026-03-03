import { EventWriter } from '@ekai/store';

/** Hooks that store events (10 of 13). */
const STORE_HOOKS = [
  { name: 'session_start', description: 'Log session start' },
  { name: 'session_end', description: 'Log session end' },
  { name: 'message_received', description: 'Log inbound message' },
  { name: 'message_sent', description: 'Log outbound message' },
  { name: 'llm_input', description: 'Log LLM request' },
  { name: 'llm_output', description: 'Log LLM response' },
  { name: 'before_tool_call', description: 'Log pre-tool invocation' },
  { name: 'after_tool_call', description: 'Log tool result' },
  { name: 'tool_result_persist', description: 'Log tool result persistence' },
  { name: 'agent_end', description: 'Log agent completion' },
] as const;

/** Hooks registered as no-ops — keeps OpenClaw aware we're listening. */
const NOOP_HOOKS = [
  { name: 'before_prompt_build', description: 'Stub for future memory injection' },
  { name: 'before_compaction', description: 'Monitor compaction start' },
  { name: 'after_compaction', description: 'Monitor compaction end' },
] as const;

export default {
  id: 'ekai-contexto',
  name: 'Ekai Contexto',
  description: 'Context engine for OpenClaw — captures lifecycle events, extensible to memory injection',
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

    // Store hooks — fire-and-forget with .catch() logging
    for (const hook of STORE_HOOKS) {
      if (hook.name === 'agent_end') {
        // agent_end: store event then flush for clean shutdown
        api.registerHook({
          name: `contexto:${hook.name}`,
          description: hook.description,
          hook: hook.name,
          handler: (event: any, ctx: any) => {
            const sessionId = event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey;
            const agentId = event?.agentId ?? ctx?.agentId;
            const userId = event?.userId ?? ctx?.userId ?? ctx?.user;
            const conversationId = event?.conversationId ?? ctx?.conversationId;

            store.append({
              hook: hook.name,
              sessionId,
              agentId,
              userId,
              conversationId,
              event: event ?? {},
              ctx,
            })
              .catch(err => api.logger.warn(`ekai-contexto: append failed: ${String(err)}`))
              .finally(() => store.flush()
                .catch(err => api.logger.warn(`ekai-contexto: flush failed: ${String(err)}`)));
          },
        });
        continue;
      }

      api.registerHook({
        name: `contexto:${hook.name}`,
        description: hook.description,
        hook: hook.name,
        handler: (event: any, ctx: any) => {
          const sessionId = event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey;
          const agentId = event?.agentId ?? ctx?.agentId;
          const userId = event?.userId ?? ctx?.userId ?? ctx?.user;
          const conversationId = event?.conversationId ?? ctx?.conversationId;

          store.append({
            hook: hook.name,
            sessionId,
            agentId,
            userId,
            conversationId,
            event: event ?? {},
            ctx,
          }).catch(err => {
            api.logger.warn(`ekai-contexto: store.append failed: ${String(err)}`);
          });
        },
      });
    }

    // No-op hooks — registered so OpenClaw knows we're listening
    for (const hook of NOOP_HOOKS) {
      api.registerHook({
        name: `contexto:${hook.name}`,
        description: hook.description,
        hook: hook.name,
        handler: () => {},
      });
    }

    api.logger.info(`ekai-contexto: storing events to ${dataDir}`);
  },
};
