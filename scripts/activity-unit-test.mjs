import assert from 'node:assert/strict';
import { activityHostname, toolActivity, parseActivity } from '../lib/kino/activity.ts';
import { consumeChatStream } from '../lib/kino/chat-stream.ts';
import { safeToolActivity } from '../lib/kino/activity-server.ts';
import { validatePublicUrl } from '../browser-worker/url-security.ts';

const secret = 'SECRET_SENTINEL';
const url = `https://tailscale.com/docs/${secret}?token=${secret}#${secret}`;
assert.equal(activityHostname(url), 'tailscale.com');
for (const unsafe of [
  `https://user:${secret}@tailscale.com/`, 'http://localhost', 'http://foo.local',
  'http://metadata.google.internal', 'http://internal', 'http://server.home.arpa',
  'http://127.0.0.1', 'http://2130706433', 'http://0x7f000001', 'http://10.1.2.3',
  'http://192.168.0.1', 'http://[::1]', 'http://[fd00::1]', 'file:///etc/passwd',
  'https://broken', `https://${secret}@tailscale.com/`,
]) assert.equal(activityHostname(unsafe), undefined, unsafe);
assert.deepEqual(toolActivity('web_open_url', { url }), { kind: 'browser', label: 'Opening tailscale.com' });
assert.deepEqual(toolActivity('web_observe', {}, url), { kind: 'reading', label: 'Reading tailscale.com' });
assert.equal(toolActivity('web_observe', {}, url, true).label, 'Inspecting results...');
assert.equal(toolActivity('web_action', { action: 'back' }, url).label, 'Navigating tailscale.com');
assert.equal(toolActivity('web_action', { action: 'fill', value: secret }, url).label, 'Updating page control...');
assert.equal(toolActivity(secret, { token: secret }, url).label, 'Running tool...');
assert.equal(toolActivity('web_confirm_pending_action', {}).kind, 'verification');
assert.equal(toolActivity('web_open_url', { url: 'http://127.0.0.1/private' }).label, 'Opening page...');
for (const [address, expected] of [['93.184.216.34', 'Opening tailscale.com'], ['10.0.0.1', 'Opening page...']]) {
  const result = await safeToolActivity('web_open_url', { url }, undefined, false, cleanUrl => {
    assert.equal(cleanUrl, 'https://tailscale.com/');
    return validatePublicUrl(cleanUrl, { lookup: async () => [{ address, family: 4 }] });
  });
  assert.equal(result.label, expected);
}
assert.equal((await safeToolActivity('web_open_url', { url }, undefined, false, async () => { throw Error(secret); })).label, 'Opening page...');

const events = [
  { type: 'start' },
  { type: 'status', kind: 'reasoning', label: 'Reasoning deeply...', thinking: secret },
  { type: 'status', ...toolActivity('web_open_url', { url }), tool_calls: [secret] },
  { type: 'delta', content: 'Text' },
  { type: 'reset' },
  { type: 'status', kind: 'reading', label: 'Reading tailscale.com' },
  { type: 'delta', content: 'Final' }, { type: 'done' },
];
let current = null, text = '';
const seen = [];
await consumeChatStream(new Response(events.map(event => JSON.stringify(event)).join('\n')).body,
  delta => { current = null; text += delta; }, undefined,
  () => { text = ''; }, next => { current = next; seen.push(next); });
assert.equal(current, null);
assert.equal(text, 'Final');
assert.equal(seen.length, 3);
assert.ok(!JSON.stringify(seen).includes(secret));
assert.equal(seen[1].label, 'Opening tailscale.com');
assert.equal(seen[2].label, 'Reading tailscale.com');
for (const event of [
  { kind: 'browser', label: url }, { kind: 'browser', label: 'Opening localhost' },
  { kind: 'browser', label: 'Opening 192.168.1.1' }, { kind: secret, label: 'Working...' },
  { kind: 'reasoning', label: secret }, { kind: 'browser', label: 'Opening tailscale.com?token=secret' },
]) assert.equal(parseActivity(event), null);
await assert.rejects(consumeChatStream(new Response(JSON.stringify({ type: 'start' }) + '\n' + JSON.stringify({ type: 'status', kind: 'reasoning', label: secret })).body, () => {}), /Invalid activity/);
console.log('Activity tests passed: safe hostnames, deterministic mapping, replacement/reset, delta clearing, and extra-field isolation.');
