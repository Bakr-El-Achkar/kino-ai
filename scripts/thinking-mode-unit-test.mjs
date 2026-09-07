import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as inference from '../lib/kino/ollama/inference.ts';
import * as transcript from '../lib/kino/ollama/transcript.ts';
import * as retry from '../lib/kino/ollama/transport-retry.ts';
import * as diagnostics from '../lib/kino/ollama/http-error-diagnostics.ts';
import * as responseHelpers from '../lib/kino/browser-worker/response.ts';
import * as continuation from '../lib/kino/browser-worker/continuation.ts';
import { parseActionConfirmation } from '../lib/kino/web-agent/action-confirmation.ts';

const env = { OLLAMA_MODEL: 'normal-fixture', OLLAMA_THINKING_MODEL: 'thinking-fixture' };
assert.equal(inference.parseReasoningMode(undefined), 'normal');
for (const bad of [null, true, 'deep', {}, 'arbitrary-model']) {
  assert.throws(() => inference.parseReasoningMode(bad), { code: 'INVALID_REASONING_MODE' });
}
assert.deepEqual(inference.resolveInference('normal', env), {
  model: 'normal-fixture', think: false, options: { num_ctx: 8192, num_predict: 1024 },
});
assert.deepEqual(inference.resolveInference('thinking', env), {
  model: 'thinking-fixture', think: true, options: { num_ctx: 8192, num_predict: 2048 },
});
assert.deepEqual(inference.resolveInference('thinking', { ...env, KINO_THINK_NUM_CTX: '9000', KINO_THINK_NUM_PREDICT: '3000' }).options, { num_ctx: 9000, num_predict: 3000 });
assert.deepEqual(inference.resolveInference('normal', { ...env, KINO_NUM_CTX: '7000', KINO_NUM_PREDICT: '900', KINO_THINK_NUM_CTX: '9999' }).options, { num_ctx: 7000, num_predict: 900 });
for (const invalid of ['', '-1', 'Infinity', 'wrong', '1.5']) {
  assert.equal(inference.resolveInference('thinking', { ...env, KINO_THINK_NUM_PREDICT: invalid }).options.num_predict, 2048);
}
assert.throws(() => inference.resolveInference('thinking', {}), { code: 'THINKING_MODEL_NOT_CONFIGURED' });

// Execute the actual route with deterministic model/worker boundaries and the real
// transcript, transport retry, response formatting, and continuation implementations.
let actions = [], requests = [], queue = [], logs = [];
const modules = {
  '@/lib/kino/ollama/inference': inference,
  '@/lib/kino/ollama/transcript': transcript,
  '@/lib/kino/ollama/transport-retry': retry,
  '@/lib/kino/ollama/http-error-diagnostics': diagnostics,
  '@/lib/kino/browser-worker/response': responseHelpers,
  '@/lib/kino/browser-worker/continuation': continuation,
  '@/lib/kino/browser-worker/routing': { requestedBrowserUrl: () => null, browserRuntimeStateMessage: () => 'fixture' },
  '@/lib/kino/browser-worker/client': { observeBrowser: async () => ({ observation: { status: 'AUTH_REQUIRED' } }), openBrowserUrl: async () => { throw Error('unexpected direct open'); } },
  '@/lib/kino/tools': {
    getOllamaTools: () => [{ type: 'function', function: { name: 'web_action' } }],
    latestActualUserMessage: messages => messages.findLast(m => m.role === 'user')?.content ?? '',
    createChatToolContext: args => args,
    executeKinoTool: async (name, args, context) => {
      actions.push({ name, args, context });
      if (args.action === 'confirm_pending') return { status: parseActionConfirmation({ message: context.latestUserMessage, risk: 'write' }).explicit ? 'ACTION_COMPLETED' : 'CONFIRMATION_REJECTED' };
      return { status: 'ACTION_COMPLETED', message: `trusted result ${actions.length}` };
    },
  },
};
const source = readFileSync('app/api/kino/route.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const exports = {};
new Function('require', 'exports', compiled)(name => {
  assert.ok(modules[name], `Unexpected dependency ${name}`);
  return modules[name];
}, exports);
const originalFetch = globalThis.fetch;
const originalError = console.error, originalWarn = console.warn;
const previousEnv = { ...process.env };
const secret = 'PRIVATE_THINKING_SENTINEL';
const tool = (step, extra = {}) => ({ message: { content: '', thinking: secret, tool_calls: [{ function: { name: 'web_action', arguments: { elementId: `e${step}`, ...extra } } }] } });
async function run(body, replies) {
  actions = []; requests = []; logs = []; queue = [...replies];
  const result = await exports.POST(new Request('http://localhost/api/kino', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'Complete the browser goal' }], ...body }) }));
  const text = await result.text();
  assert.ok(!JSON.stringify({ text, requests, actions, logs }).includes(secret), 'Raw thinking escaped response boundary');
  return { status: result.status, text };
}
try {
  Object.assign(process.env, env);
  delete process.env.KINO_NUM_CTX; delete process.env.KINO_NUM_PREDICT;
  delete process.env.KINO_THINK_NUM_CTX; delete process.env.KINO_THINK_NUM_PREDICT;
  console.error = (...args) => logs.push(args); console.warn = (...args) => logs.push(args);
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    assert.ok(queue.length, 'Unexpected model call/retry');
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next instanceof Response ? next : Response.json(next);
  };
  assert.deepEqual(await run({ model: 'client-override', think: true }, [{ message: { content: 'Normal answer', thinking: secret } }]), { status: 200, text: 'Normal answer' });
  assert.equal(requests[0].model, env.OLLAMA_MODEL);
  assert.equal(requests[0].think, false);
  assert.deepEqual(requests[0].options, { num_ctx: 8192, num_predict: 1024 });
  for (const steps of [0, 1, 2, 3]) {
    const body = { reasoningMode: 'thinking', model: 'untrusted', messages: [{ role: 'user', content: 'Complete the browser goal', thinking: secret }] };
    const before = JSON.stringify(body);
    const result = await run(body, [...Array.from({ length: steps }, (_, i) => tool(i)), { message: { content: 'Verified final answer', thinking: secret } }]);
    assert.equal(result.text, 'Verified final answer');
    assert.equal(JSON.stringify(body), before, 'Visible history mutated');
    assert.equal(actions.length, steps, 'Completed actions replayed');
    for (const [index, request] of requests.entries()) {
      assert.equal(request.model, env.OLLAMA_THINKING_MODEL);
      assert.equal(request.think, true);
      assert.deepEqual(request.options, { num_ctx: 8192, num_predict: 2048 });
      assert.ok(!('think' in request.options));
      assert.equal(request.messages.filter(transcript.isInternalContinuationDirective).length, index ? 1 : 0);
      if (index) {
        assert.equal(request.messages.at(-1).role, 'user');
        assert.equal(request.messages.filter(m => m.role === 'tool').length, index);
      }
    }
  }
  await run({ reasoningMode: 'thinking' }, [tool(0), new TypeError('terminated'), { message: { content: 'Done', thinking: secret } }]);
  assert.equal(actions.length, 1); assert.equal(requests.length, 3);
  for (const user of ["don't ask me", 'Complete the browser goal']) {
    const result = await run({ reasoningMode: 'thinking', messages: [{ role: 'user', content: user }] }, [tool(0, { action: 'confirm_pending', confirmation: 'yes' })]);
    assert.equal(actions[0].context.latestUserMessage, user);
    assert.notEqual(result.text, 'Verified final answer');
    assert.equal(requests.length, 1);
  }
  const credentials = await run({ reasoningMode: 'thinking', messages: [{ role: 'user', content: 'password: fixture' }] }, []);
  assert.match(credentials.text, /secure login/); assert.equal(requests.length, 0);
  const invalid = await run({ reasoningMode: 'invalid' }, []);
  assert.equal(invalid.status, 400); assert.match(invalid.text, /INVALID_REASONING_MODE/);
  delete process.env.OLLAMA_THINKING_MODEL;
  const missing = await run({ reasoningMode: 'thinking' }, []);
  assert.equal(missing.status, 503); assert.match(missing.text, /THINKING_MODEL_NOT_CONFIGURED/);
  assert.equal(requests.length, 0); assert.equal(actions.length, 0);
  process.env.OLLAMA_THINKING_MODEL = env.OLLAMA_THINKING_MODEL;
  await run({ reasoningMode: 'thinking' }, [new Response(JSON.stringify({ error: `No user query found in messages. ${secret}` }), { status: 500, headers: { 'Content-Type': 'application/json' } })]);
  assert.equal(requests.length, 1);
  assert.equal(logs[0][1].modelErrorClassification, 'MODEL_TRANSCRIPT_INVALID');
  await run({ reasoningMode: 'thinking' }, [new Response(JSON.stringify({ error: secret }), { status: 404, headers: { 'Content-Type': 'application/json' } })]);
  assert.equal(requests.length, 1);
  await run({ reasoningMode: 'thinking' }, [{ error: secret, message: { thinking: secret } }]);
  assert.equal(requests.length, 1);
  await run({ reasoningMode: 'thinking' }, [new Response(`invalid ${secret}`)]);
  assert.equal(requests.length, 1);
} finally {
  globalThis.fetch = originalFetch; console.error = originalError; console.warn = originalWarn;
  for (const key of Object.keys(env).concat(['KINO_NUM_CTX', 'KINO_NUM_PREDICT', 'KINO_THINK_NUM_CTX', 'KINO_THINK_NUM_PREDICT'])) {
    if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
  }
}
const page = readFileSync('app/page.tsx', 'utf8');
assert.match(page, /useState<ReasoningMode>\("normal"\)/);
assert.match(page, /reasoningMode: mode/);
assert.match(page, /Reasoning deeply/);
assert.doesNotMatch(page, /OLLAMA_THINKING_MODEL|message\.thinking/);
assert.match(page, /if \(isBusy\) \{\s+return;/);
console.log('Thinking mode inference and route integration tests passed.');
