import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { format } from 'node:util';
import ts from 'typescript';
import { chromium } from 'playwright';

// Proposed V1 contract for RED review: one request-scoped image, never history
// attachments; { image: { mimeType, base64 } }, at most 3 MiB of decoded bytes.
// Exercise the actual route like thinking-mode-unit-test.mjs. Only external
// Ollama/worker boundaries are replaced; validation/routing/streaming stay real.
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const originalEnv = { ...process.env };
const env = {
  OLLAMA_HOST: 'http://ollama.image-upload.test',
  OLLAMA_MODEL: 'text-upload-fixture',
  OLLAMA_THINKING_MODEL: 'thinking-upload-fixture',
  OLLAMA_VISION_MODEL: 'vision-upload-fixture',
};
let browser, fixtures, route;
let actions = [];
const modules = new Map();
const unexpectedAction = async () => {
  actions.push('browser-action');
  throw new Error('Image description must not invoke browser tools');
};
const boundaries = {
  '@/lib/kino/browser-worker/client': {
    observeBrowser: unexpectedAction,
    openBrowserUrl: unexpectedAction,
  },
  '@/lib/kino/tools': {
    getOllamaTools: () => [{ type: 'function', function: { name: 'web_vision_observe' } }],
    latestActualUserMessage: messages => messages.findLast(message => message.role === 'user')?.content ?? '',
    createChatToolContext: args => args,
    executeKinoTool: unexpectedAction,
  },
};
function loadTs(filename) {
  const absolute = resolve(filename);
  if (modules.has(absolute)) return modules.get(absolute);
  const exports = {};
  modules.set(absolute, exports);
  const compiled = ts.transpileModule(readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const localRequire = createRequire(absolute);
  new Function('require', 'exports', compiled)(name => {
    if (boundaries[name]) return boundaries[name];
    if (name.startsWith('@/')) return loadTs(`${name.slice(2)}.ts`);
    if (name.endsWith('.ts')) return loadTs(localRequire.resolve(name));
    return localRequire(name);
  }, exports);
  return exports;
}

before(async () => {
  Object.assign(process.env, env);
  delete process.env.OLLAMA_API_KEY;
  route = loadTs('app/api/kino/route.ts');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // Browser encoders give us real, decodable files for all three formats.
  fixtures = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 2;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#3179ad';
    ctx.fillRect(0, 0, 2, 2);
    return Object.fromEntries(['image/jpeg', 'image/png', 'image/webp'].map(mimeType => [
      mimeType, { mimeType, base64: canvas.toDataURL(mimeType).split(',')[1] },
    ]));
  });
  await page.close();
});

after(async () => {
  await browser?.close();
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

async function chat(extra = {}, upstreamError) {
  const requests = [], logs = [];
  actions = [];
  const originalFetch = globalThis.fetch;
  const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'];
  const originalConsole = Object.fromEntries(consoleMethods.map(name => [name, console[name]]));
  try {
    for (const name of consoleMethods) console[name] = (...args) => logs.push(format(...args));
    globalThis.fetch = async (_url, init) => {
      const request = JSON.parse(init.body);
      requests.push(request);
      if (upstreamError) return Response.json({ error: upstreamError }, { status: 400 });
      const message = { role: 'assistant', content: 'A blue square.' };
      if (!request.stream) return Response.json({ message, done: true });
      return new Response([
        { message: { thinking: 'PRIVATE_THINKING_FIXTURE' }, done: false },
        { message, done: false }, { done: true },
      ].map(record => JSON.stringify(record)).join('\n'), {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    };
    const response = await route.POST(new Request('http://localhost/api/kino', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'image-upload-test',
        messages: [{ role: 'user', content: 'Describe this image briefly.' }],
        reasoningMode: 'normal', ...extra,
      }),
    }));
    const wire = await response.text();
    assert.equal(actions.length, 0, 'Upload chat invoked browser screenshot/action tools');
    assert.equal(wire.includes('PRIVATE_THINKING_FIXTURE'), false, 'Hidden thinking reached the client');
    return { status: response.status, wire, requests, logs };
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(console, originalConsole);
  }
}

for (const mimeType of ['image/jpeg', 'image/png', 'image/webp']) {
  test(`accepts ${mimeType} and actually forwards the uploaded image`, async () => {
    const image = fixtures[mimeType];
    const result = await chat({ image });
    assert.equal(result.status, 200);
    assert.equal(result.requests.length, 1, 'An upload needs one vision inference');
    assert.ok(result.wire.includes('A blue square.'), 'Missing visible vision answer');
    assert.ok(result.requests[0].messages.some(message => message.role === 'user' && message.images?.length === 1),
      `Accepted ${mimeType} must reach Ollama, not be silently dropped`);
    assert.equal(result.logs.join('\n').includes(image.base64), false, 'Successful upload logged image data');
  });
}

test('rejects an unsupported image MIME before model inference', async () => {
  const result = await chat({ image: { ...fixtures['image/png'], mimeType: 'image/gif' } });
  assert.ok(result.status >= 400 && result.status < 500, 'Unsupported MIME must return a client error');
  assert.equal(result.requests.length, 0, 'Invalid image reached Ollama');
});

test('rejects an image exceeding 3 MiB decoded size before model inference', async () => {
  const bytes = Buffer.concat([Buffer.from(fixtures['image/jpeg'].base64, 'base64'), Buffer.alloc(MAX_IMAGE_BYTES)]);
  const result = await chat({ image: { mimeType: 'image/jpeg', base64: bytes.toString('base64') } });
  assert.ok(result.status >= 400 && result.status < 500, 'Oversized image must return a client error');
  assert.equal(result.requests.length, 0, 'Oversized image reached Ollama');
});

for (const reasoningMode of ['normal', 'thinking']) {
  test(`${reasoningMode} upload uses OLLAMA_VISION_MODEL`, async () => {
    const result = await chat({ image: fixtures['image/png'], reasoningMode });
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].model, env.OLLAMA_VISION_MODEL, 'Upload must select the configured vision model');
  });
}

test('Ollama message.images receives exact raw base64 without a data URI', async () => {
  const image = fixtures['image/png'];
  const result = await chat({ image });
  const images = result.requests.flatMap(request => request.messages.flatMap(message => message.images ?? []));
  assert.equal(images.length, 1, 'Expected exactly one uploaded image in message.images');
  // Boolean assertions intentionally prevent assertion reporters printing bytes.
  assert.ok(images[0] === image.base64, 'Ollama image differs from the original raw base64');
  assert.equal(images[0].startsWith('data:'), false, 'Ollama received a data URI');
});

for (const reasoningMode of ['normal', 'thinking']) {
  test(`text-only ${reasoningMode} retains existing FAST/THINK routing`, async () => {
    const result = await chat({ reasoningMode });
    assert.equal(result.status, 200);
    assert.equal(result.requests.length, 1);
    assert.equal(result.requests[0].model, reasoningMode === 'normal' ? env.OLLAMA_MODEL : env.OLLAMA_THINKING_MODEL);
    assert.equal(result.requests[0].think, reasoningMode === 'thinking');
    assert.equal(result.requests[0].stream, true);
    assert.ok(result.requests[0].messages.every(message => !message.images?.length));
  });
}

test('upstream errors cannot expose uploaded base64 in client errors or logs', async () => {
  const image = fixtures['image/png'];
  const result = await chat({ image }, `Unable to decode private upload ${image.base64}`);
  assert.equal(result.requests.length, 1, 'Error handling retried inference');
  assert.equal(result.wire.includes(image.base64), false, 'Client error exposed image base64');
  assert.equal(result.logs.join('\n').includes(image.base64), false, 'Server diagnostics exposed image base64');
});

// Same running-app convention as chat-stream-ui-test.mjs. API requests are
// intercepted, so this never contacts Ollama or the browser worker through Next.
for (const width of [1280, 390]) {
  test(`composer picker and compact control layout at ${width}px`, { timeout: 60_000 }, async () => {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    try {
      await page.goto(process.env.CHAT_TEST_URL || 'http://localhost:3100');
      const text = page.getByRole('textbox', { name: 'Message KINO', exact: true });
      await text.fill('');
      const attach = page.getByRole('button', { name: 'Attach image', exact: true });
      const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
      await attach.click();
      const chooser = await chooserPromise;
      assert.equal(await chooser.element().getAttribute('type'), 'file');
      assert.equal(await chooser.element().getAttribute('accept'), 'image/jpeg,image/png,image/webp');
      assert.equal(chooser.isMultiple(), false);
      const left = await attach.boundingBox();
      const middle = await text.boundingBox();
      const right = await page.getByRole('button', { name: 'Send message', exact: true }).boundingBox();
      assert.ok(Math.abs(left.y - right.y) < 4, 'Attach and send must occupy the same compact row');
      assert.ok(left.x + left.width <= middle.x && middle.x + middle.width <= right.x, 'Controls must not overlap');
      assert.ok((await page.locator('.command-input-row').boundingBox()).height < 90, 'Empty composer is too tall');
      await chooser.setFiles({ name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(fixtures['image/png'].base64, 'base64') });
      await page.getByAltText('Selected image preview').waitFor();
      assert.ok(await page.locator('.image-upload-preview').innerText().then(value => /sample\.png/.test(value) && /KiB|MiB|bytes/.test(value)), 'Preview must show filename and size');
      const oldUrl = await page.getByAltText('Selected image preview').getAttribute('src');
      await page.getByRole('button', { name: 'Remove image', exact: true }).click();
      assert.equal(await page.locator('input[type="file"]').evaluate(element => element.files.length), 0);
      assert.equal(await page.evaluate(async url => { try { await fetch(url); return false; } catch { return true; } }, oldUrl), true, 'Removed preview URL must be revoked');
      for (const [mimeType, name] of [['image/png', 'sample.png'], ['image/jpeg', 'sample.jpg'], ['image/webp', 'sample.webp']]) {
        const nextChooser = page.waitForEvent('filechooser', { timeout: 5000 });
        await attach.focus();
        await attach.press('Enter');
        await (await nextChooser).setFiles({ name, mimeType, buffer: Buffer.from(fixtures[mimeType].base64, 'base64') });
        await page.getByAltText('Selected image preview').waitFor();
        assert.ok((await page.locator('.image-upload-preview').innerText()).includes(name));
        await page.getByRole('button', { name: 'Remove image', exact: true }).click();
      }
    } finally { await page.close(); }
  });
}

test('composer selects one image, replaces its preview, and removes it before sending', { timeout: 60_000 }, async () => {
  const page = await browser.newPage();
  const sent = [];
  try {
    await page.route('**/api/kino', async route => {
      sent.push(route.request().postDataJSON());
      await route.fulfill({ contentType: 'application/x-ndjson', body:
        [{ type: 'start' }, { type: 'delta', content: 'Received.' }, { type: 'done' }].map(event => JSON.stringify(event)).join('\n') });
    });
    await page.route('**/api/kino/browser-state', route => route.fulfill({ json: { active: false, status: 'SESSION_EXPIRED' } }));
    await page.goto(process.env.CHAT_TEST_URL || 'http://localhost:3100');
    const text = page.getByRole('textbox', { name: 'Message KINO', exact: true });
    await text.fill('Describe this.'); // Wait for the actual hydrated composer.
    const input = page.locator('input[type="file"]');
    assert.equal(await input.count(), 1, 'Composer must provide a single-image file selector');
    assert.equal(await input.evaluate(element => element.multiple), false, 'File selector permits multiple images');
    const file = (mimeType, name) => ({ name, mimeType, buffer: Buffer.from(fixtures[mimeType].base64, 'base64') });
    const preview = page.locator('form img');
    await input.setInputFiles(file('image/png', 'first.png'));
    await preview.waitFor({ state: 'visible' });
    const firstSource = await preview.getAttribute('src');
    await input.setInputFiles(file('image/webp', 'replacement.webp'));
    await page.waitForFunction(old => document.querySelector('form img')?.getAttribute('src') !== old, firstSource);
    assert.equal(await preview.count(), 1, 'Selecting again appended a second image');
    await page.getByRole('button', { name: /remove image/i }).click();
    assert.equal(await preview.count(), 0, 'Remove image left a preview');
    assert.equal(await input.evaluate(element => element.files.length), 0, 'Remove image left the file selected');
    const removed = page.waitForResponse('**/api/kino');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await removed;
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].image, 'Removed image was sent');
    await input.setInputFiles(file('image/png', 'send.png'));
    await text.fill('Describe.');
    const received = page.waitForResponse('**/api/kino');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await received;
    assert.equal(sent.length, 2);
    assert.ok(sent[1].image?.base64 === fixtures['image/png'].base64, 'Selected upload missing from request');
    assert.equal(sent[1].image.mimeType, 'image/png');
    await text.fill('Now say hello.');
    const followup = page.waitForResponse('**/api/kino');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await followup;
    assert.equal(JSON.stringify(sent[2]).includes(fixtures['image/png'].base64), false, 'Image bytes persisted into later chat history');
    await input.setInputFiles(file('image/jpeg', 'image-only.jpg'));
    await text.fill('');
    const imageOnly = page.waitForResponse('**/api/kino');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await imageOnly;
    assert.equal(sent[3].messages.at(-1).content, 'Analyze this image.');
    assert.equal(sent[3].image.mimeType, 'image/jpeg');
    for (const [label, mode] of [['THINK', 'thinking'], ['FAST', 'normal']]) {
      await page.getByRole('group', { name: 'Response mode' }).getByRole('button', { name: label, exact: true }).click();
      await text.fill('Hello.');
      const response = page.waitForResponse('**/api/kino');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await response;
      assert.equal(sent.at(-1).reasoningMode, mode);
      assert.ok(!sent.at(-1).image);
    }
  } finally {
    await page.close();
  }
});
