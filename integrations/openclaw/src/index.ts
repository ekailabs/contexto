import { EventLog } from './store.js';

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
  configSchema: {},

  register(api: any) {
    const logPath = api.resolvePath(api.pluginConfig?.logPath ?? '~/.openclaw/ekai/events.jsonl');
    const log = new EventLog(logPath);

    for (const hook of HOOKS) {
      api.registerHook({
        name: `contexto:${hook.name}`,
        description: hook.description,
        hook: hook.name,
        handler: (event: unknown, ctx: unknown) => {
          try {
            log.append(hook.name, event, ctx);
          } catch (err) {
            // Never crash OpenClaw — log the failure and move on
            api.logger.warn(`ekai-contexto: failed to log ${hook.name}: ${String(err)}`);
          }
        },
      });
    }

    api.logger.info(`ekai-contexto: logging to ${logPath}`);
  },
};
