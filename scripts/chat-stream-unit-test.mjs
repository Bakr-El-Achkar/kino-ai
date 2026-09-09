import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as normalization from '../components/chat/normalize-markdown.ts';
import { consumeChatStream, readNdjson } from '../lib/kino/chat-stream.ts';
import { readOllamaRound, streamChatResponse } from '../lib/kino/ollama/final-stream.ts';

const secret = 'PRIVATE_REASONING_NEVER_FORWARD';
const encoder = new TextEncoder();
const allowed = new Set(['web_action']);
const eventBytes = event => encoder.encode(JSON.stringify(event) + '\n');
const bodyFrom = records => new ReadableStream({ start(controller) { records.forEach(record => controller.enqueue(eventBytes(record))); controller.close(); } });
const streamed = (body, signal = new AbortController().signal, onResult = () => {}) => streamChatResponse(signal, 10_000, async (publish, linkedSignal) => {
  onResult(await readOllamaRound(body, linkedSignal, allowed, publish));
});

// The response yields visible text before upstream completion, skipping all thinking fields.
let upstream, cancelled = false;
const body = new ReadableStream({ start(controller) { upstream = controller; }, cancel() { cancelled = true; } });
const response = streamed(body);
const events = readNdjson(response.body)[Symbol.asyncIterator]();
assert.deepEqual((await events.next()).value, { type: 'start' });
upstream.enqueue(eventBytes({ message: { thinking: secret }, done: false }));
const first = events.next();
upstream.enqueue(eventBytes({ message: { content: '**Hel', thinking: secret }, done: false }));
assert.deepEqual((await first).value, { type: 'delta', content: '**Hel' });
upstream.enqueue(eventBytes({ message: { content: 'lo** \u{1f30d}' }, done: false }));
assert.deepEqual((await events.next()).value, { type: 'delta', content: 'lo** \u{1f30d}' });
upstream.enqueue(eventBytes({ message: { thinking: secret }, done: true }));
assert.deepEqual((await events.next()).value, { type: 'done' });
assert.equal((await events.next()).done, true);
assert.equal(cancelled, true);

// Tool records can span arbitrary network boundaries. Nothing is executable before done.
let toolUpstream, finished = false, toolResult;
const toolBody = new ReadableStream({ start(controller) { toolUpstream = controller; } });
const pendingTool = readOllamaRound(toolBody, new AbortController().signal, allowed, () => {}).then(result => { finished = true; toolResult = result; });
const call = { function: { index: 0, name: 'web_action', arguments: { elementId: 'e1' } } };
const bytes = eventBytes({ message: { thinking: secret, tool_calls: [call] }, done: false });
for (const byte of bytes) toolUpstream.enqueue(Uint8Array.of(byte));
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(finished, false, 'Tool returned before the done record');
toolUpstream.enqueue(eventBytes({ message: { tool_calls: [call] }, done: true }));
await pendingTool;
assert.equal(toolResult.tool_calls.length, 1, 'Repeated indexed call was duplicated');
assert.deepEqual(toolResult.tool_calls[0], { function: { name: 'web_action', arguments: { elementId: 'e1' } } });
assert.ok(!JSON.stringify(toolResult).includes(secret));

// Missing done, malformed/partial arguments, conflicting indexed calls, and unknown tools fail closed.
for (const records of [
  [{ message: { tool_calls: [call] } }],
  [{ message: { tool_calls: [call] }, done: true, done_reason: 'length' }],
  [{ message: { tool_calls: [{ function: { name: 'web_action', arguments: '{partial' } }] } }, { done: true }],
  [{ message: { tool_calls: [{ function: { name: 'unknown_tool', arguments: {} } }] } }, { done: true }],
  [{ message: { tool_calls: [call] } }, { message: { tool_calls: [{ function: { index: 0, name: 'web_action', arguments: { elementId: 'e2' } } }] }, done: true }],
]) {
  await assert.rejects(readOllamaRound(bodyFrom(records), new AbortController().signal, allowed, () => {}));
}

// Mixed content/tool rounds clear only provisional visible content; tool data never reaches UI.
const mixedWire = await streamed(bodyFrom([
  { message: { content: 'Checking...', thinking: secret } },
  { message: { tool_calls: [call], content: 'Private tool narration' }, done: true },
])).text();
const mixedEvents = mixedWire.trim().split('\n').map(line => JSON.parse(line));
assert.deepEqual(mixedEvents.map(event => event.type), ['start', 'delta', 'reset', 'done']);
assert.ok(!mixedWire.includes(secret));
assert.ok(!mixedWire.includes('web_action'));
assert.ok(!mixedWire.includes('Private tool narration'));
let resetContent = '';
await consumeChatStream(new Response(mixedWire).body, delta => { resetContent += delta; }, undefined, () => { resetContent = ''; });
assert.equal(resetContent, '');

// Sanitized errors retain already visible content; malformed upstream text cannot leak.
for (const records of [
  [{ message: { content: 'Kept' } }, { error: secret }],
  [{ message: { content: 'Kept' } }],
]) {
  const wire = await streamed(bodyFrom(records)).text();
  assert.ok(!wire.includes(secret));
  let kept = '';
  await assert.rejects(consumeChatStream(new Response(wire).body, delta => { kept += delta; }), /interrupted/);
  assert.equal(kept, 'Kept');
}
assert.ok(!(await streamed(new Response(`{"message":{"thinking":"${secret}"`).body).text()).includes(secret));

// Cancellation stops readers and cannot return a pending tool to the caller.
for (const cancelReader of [true, false]) {
  let cancelled = false, executed = false;
  const controller = new AbortController();
  const upstream = new ReadableStream({ start(output) { output.enqueue(eventBytes({ message: { tool_calls: [call] } })); }, cancel() { cancelled = true; } });
  const reader = streamed(upstream, controller.signal, () => { executed = true; }).body.getReader();
  await reader.read();
  await new Promise(resolve => setTimeout(resolve, 0));
  if (cancelReader) await reader.cancel();
  else { controller.abort(); while (!(await reader.read()).done) { /* drain reset */ } }
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
  assert.equal(executed, false);
}
const abortController = new AbortController();
let clientCancelled = false;
const pending = consumeChatStream(new ReadableStream({ cancel() { clientCancelled = true; } }), () => {}, abortController.signal);
abortController.abort();
await assert.rejects(pending, { name: 'AbortError' });
assert.equal(clientCancelled, true);

  // Every possible byte boundary, including UTF-8 and JSON escapes, reconstructs exactly.
  const expected = '**Hello** 🌍\n\n```js\nconst x = "é";\n```';
  const wire = [
    { type: 'start' }, { type: 'delta', content: expected.slice(0, 6) },
    { type: 'delta', content: expected.slice(6) }, { type: 'done' },
  ].map(event => JSON.stringify(event)).join('\r\n');
  let combined = '';
  await consumeChatStream(new ReadableStream({ start(controller) {
    for (const byte of encoder.encode(wire)) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } }), delta => { combined += delta; });
  assert.equal(combined, expected);

  // Render the actual component at every prefix, including incomplete tables/fences/emphasis.
  const modules = { react: React, 'react/jsx-runtime': jsxRuntime, 'react-markdown': { default: ReactMarkdown }, 'remark-gfm': { default: remarkGfm }, './normalize-markdown': normalization };
  const compiled = ts.transpileModule(readFileSync('components/chat/MarkdownMessage.tsx', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const component = {};
  new Function('require', 'exports', compiled)(name => { assert.ok(modules[name], name); return modules[name]; }, component);
  const markdown = `${expected}\n\n| Name | Value |\n| --- | --- |\n| KINO | Yes |`;
  for (let end = 1; end <= markdown.length; end++) {
    assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(component.MarkdownMessage, { content: markdown.slice(0, end) })));
  }
console.log('Chat streaming tests passed: progressive content, thinking isolation, complete validated tools, resets, byte framing, cancellation, and partial Markdown.');
