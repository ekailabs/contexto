import { EventWriter } from '@ekai/store';

const HOOKS = [
  { name: 'session_start', description: 'Log session start' },
  { name: 'session_end', description: 'Log session end' },
  { name: 'message_received', description: 'Log inbound message' },
  { name: 'message_sent', description: 'Log outbound message' },
  { name: 'before_prompt_build', description: 'Log pre-prompt state' },
  { name: 'llm_input', description: 'Log LLM request' },
  { name: 'llm_output', description: 'Log LLM response' },
  { name: 'before_tool_call', description: 'Log pre-tool invocation' },
  { name: 'after_tool_call', description: 'Log tool result' },
  { name: 'tool_result_persist', description: 'Log tool result persistence' },
  { name: 'agent_end', description: 'Log agent completion' },
  { name: 'before_compaction', description: 'Log pre-compaction state' },
  { name: 'after_compaction', description: 'Log post-compaction state' },
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

    for (const hook of HOOKS) {
      api.registerHook({
        name: `contexto:${hook.name}`,
        description: hook.description,
        hook: hook.name,
        handler: (event: any, ctx: any) => {
          try {
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
            });
          } catch (err) {
            api.logger.warn(`ekai-contexto: store.append failed: ${String(err)}`);
          }
        },
      });
    }

    api.logger.info(`ekai-contexto: storing events to ${dataDir}`);
  },
};
