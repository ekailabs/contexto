// Generate canonical-JSON fixture for buildEpisodePayload from the TS reference.
//
// This script re-implements buildPayload + buildEpisodePayload VERBATIM from
// /home/ubuntu/research/contexto/packages/contexto/src/helpers.ts and engine/utils.ts.
// It then writes the JSON output (after stringify) to episode_payload.json.
//
// Python's build_episode_payload must produce canonical-JSON-equal output:
//     json.dumps(payload, sort_keys=True, ensure_ascii=False)
//     === JSON.stringify(payload sorted keys)
//
// Run: node generate_episode_fixture.mjs

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Verbatim port of TS buildPayload (src/helpers.ts) ---
function buildPayload(type, action, sessionKey, context, agent, data) {
  return {
    event: { type, action },
    sessionKey,
    timestamp: new Date().toISOString(),
    context,
    agent,
    data,
  };
}

// --- Verbatim port of TS buildEpisodePayload (src/engine/utils.ts) ---
function buildEpisodePayload(messages, sessionId, sessionKey, runtimeContext) {
  return buildPayload('episode', 'combined', sessionKey, {
    sessionId,
    model: runtimeContext?.model,
    provider: runtimeContext?.provider,
  }, undefined, {
    messages,
  });
}

// --- Frozen inputs ---
const FROZEN_TS = '2026-05-23T18:30:00.000Z';
const realDate = Date;
globalThis.Date = class extends realDate {
  constructor(...args) {
    if (args.length === 0) {
      super(FROZEN_TS);
    } else {
      super(...args);
    }
  }
  static now() { return realDate.parse(FROZEN_TS); }
};

const FIXTURES = [
  {
    name: 'basic',
    messages: [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ],
    sessionId: 's-abc',
    sessionKey: 's-abc',
    runtimeContext: { model: 'gpt-4o', provider: 'openai' },
  },
  {
    name: 'no_runtime_context',
    messages: [{ role: 'user', content: 'q' }],
    sessionId: 's-no-rt',
    sessionKey: 's-no-rt',
    runtimeContext: undefined,
  },
  {
    name: 'only_model_set',
    messages: [{ role: 'user', content: 'q' }],
    sessionId: 's-model-only',
    sessionKey: 's-model-only',
    runtimeContext: { model: 'gpt-4o-mini' },
  },
  {
    name: 'distinct_session_key',
    messages: [{ role: 'user', content: 'hi' }],
    sessionId: 's-id-1',
    sessionKey: 's-key-2',
    runtimeContext: { model: 'claude-opus-4-7', provider: 'anthropic' },
  },
  {
    name: 'multipart_content',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this:' },
          { type: 'image_url', image_url: { url: 'https://x.test/y.png' } },
        ],
      },
    ],
    sessionId: 's-multi',
    sessionKey: 's-multi',
    runtimeContext: { model: 'gpt-4o', provider: 'openai' },
  },
];

const out = {};
for (const f of FIXTURES) {
  const payload = buildEpisodePayload(f.messages, f.sessionId, f.sessionKey, f.runtimeContext);
  // Serialize the way Python will compare: JSON.stringify naturally drops undefined.
  // We then parse + canonicalize via sorted keys at compare time.
  out[f.name] = {
    inputs: {
      messages: f.messages,
      sessionId: f.sessionId,
      sessionKey: f.sessionKey,
      runtimeContext: f.runtimeContext === undefined ? null : f.runtimeContext,
    },
    serialized: JSON.stringify(payload),
  };
}

const target = join(__dirname, 'episode_payload.json');
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${target}`);
