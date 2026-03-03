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

function makeHandler(store: EventWriter, hookName: string, api: any) {
  return async (event: any, ctx: any) => {
    const sessionId = event?.sessionId ?? ctx?.sessionId ?? ctx?.sessionKey;
    const agentId = event?.agentId ?? ctx?.agentId;
    const userId = event?.userId ?? ctx?.userId ?? ctx?.user;
    const conversationId = event?.conversationId ?? ctx?.conversationId;

    try {
      await store.append({
        hook: hookName,
        sessionId,
        agentId,
        userId,
        conversationId,
        event: event ?? {},
        ctx,
      });

      if (hookName === 'agent_end') {
        await store.flush();
      }
    } catch (err) {
      api.logger.warn(`claw-contexto: ${hookName} failed: ${String(err)}`);
    }
  };
}

export default {
  id: 'claw-contexto',
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

    for (const hook of STORE_HOOKS) {
      api.registerHook(
        hook.name,
        makeHandler(store, hook.name, api),
        { name: `claw-contexto.${hook.name}`, description: hook.description },
      );
    }

    for (const hook of NOOP_HOOKS) {
      api.registerHook(
        hook.name,
        async () => {},
        { name: `claw-contexto.${hook.name}`, description: hook.description },
      );
    }

    api.logger.info(`claw-contexto: storing events to ${dataDir}`);
  },
};
