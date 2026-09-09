import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Run against a local Next server. All API responses are fixtures.
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const page = await context.newPage();
const example = '# Example Heading\n\nThis is **bold**, this is *italic*, and this is `inline code`.\n\n- First item\n- Second item\n  - Nested item\n\n1. Step one\n2. Step two\n\n```javascript\nfunction hello() {\n  console.log("Hello KINO");\n}\n';
let reply = example;
let request;
await page.route('**/api/kino', async route => {
  request = route.request().postDataJSON();
  await new Promise(resolve => setTimeout(resolve, 250));
  await route.fulfill({ contentType: 'application/x-ndjson', body: [{ type: 'start' }, ...Array.from(reply).map(content => ({ type: 'delta', content })), { type: 'done' }].map(event => JSON.stringify(event)).join('\n') });
});
await page.route('**/api/kino/browser-state', route => route.fulfill({ json: { active: false, status: 'SESSION_EXPIRED' } }));
try {
  await page.goto(process.env.CHAT_TEST_URL || 'http://localhost:3100');
  await page.getByRole('heading', { name: 'How can I help?' }).waitFor();
  const input = page.getByRole('textbox', { name: 'Message KINO', exact: true });
  await input.fill('First line');
  await input.press('Shift+Enter');
  await input.press('a');
  assert.equal(await input.inputValue(), 'First line\na');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Copy response', exact: true }).waitFor();
  assert.equal(request.reasoningMode, 'normal');
  assert.equal(request.messages.at(-1).content, 'First line\na');
  assert.equal(await page.locator('.chat-markdown h1').textContent(), 'Example Heading');
  assert.equal(await page.locator('.chat-markdown strong').textContent(), 'bold');
  assert.equal(await page.locator('.chat-markdown em').textContent(), 'italic');
  assert.equal(await page.locator('.chat-markdown ul ul li').textContent(), 'Nested item');
  assert.equal(await page.locator('.chat-markdown ol li').count(), 2);
  await page.getByRole('button', { name: 'Copy code', exact: true }).click();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /console.log\("Hello KINO"\)/);
  assert.equal(await page.getByRole('button', { name: 'Copy code', exact: true }).textContent(), 'Copied');
  await page.getByRole('button', { name: 'Copy response', exact: true }).click();
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll("\r\n", "\n"), example);
  reply = '\\# Repaired\n\n\\*\\*Bold repaired\\*\\*\n\n\\- List repaired\n\n> A quote\n\n---\n\n| Name | Value |\n| --- | --- |\n| KINO | Yes |\n\n[Unsafe](javascript:alert(1))\n\n<script>window.unsafe = true</script>\n\n```text\n\\*\\*keep\\*\\*\n' + 'x'.repeat(200) + '\n```\n\n' + Array.from({ length: 24 }, (_, i) => `Paragraph ${i}. Readable content.`).join('\n\n');
  await page.locator('.composer-modes').getByRole('button', { name: 'THINK' }).click();
  await input.fill('**plain user** <b>text</b>');
  await input.press('Enter');
  await page.locator('.chat-markdown h1').filter({ hasText: 'Repaired' }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Copy response"]').length === 2);
  assert.equal(request.reasoningMode, 'thinking');
  assert.equal(await page.locator('.user-bubble strong, .user-bubble b').count(), 0);
  assert.equal(await page.locator('.chat-markdown script').count(), 0);
  assert.equal(await page.locator('.chat-markdown a[href^="javascript:"]').count(), 0);
  assert.equal(await page.locator('.chat-markdown table').count(), 1);
  assert.match(await page.locator('.chat-code-block pre').last().textContent(), /\\\*\\\*keep/);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('.chat-workspace').evaluate(el => el.scrollWidth <= el.clientWidth));
    const composer = await input.boundingBox();
    assert.ok(composer.y + composer.height < 844);
  }
  await page.locator('.chat-workspace').evaluate(el => { el.scrollTop = 0; });
  await page.waitForTimeout(100);
  // A mode update must not pull someone reading earlier content to the bottom.
  await page.locator('.composer-modes').getByRole('button', { name: 'FAST' }).click();
  assert.equal(await page.locator('.chat-workspace').evaluate(el => el.scrollTop), 0);
  await input.fill('Next turn');
  await input.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Copy response"]').length === 3);
  await page.waitForFunction(() => { const el = document.querySelector(".chat-workspace"); return el.scrollHeight - el.scrollTop - el.clientHeight < 140; });
  assert.ok(await page.locator('.chat-workspace').evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 140));
  await page.route('**/api/kino/browser-state', route => route.fulfill({ json: { active: true, status: 'OBSERVED', title: 'Fixture browser', url: 'https://example.com', pageStatus: 'OBSERVED' } }));
  await page.route('**/api/kino/browser-view', route => route.fulfill({ status: 503, json: { status: 'WORKER_UNAVAILABLE' } }));
  await input.fill('Open https://example.com');
  await input.press('Enter');
  await page.getByRole('complementary', { name: 'KINO Live Browser' }).waitFor();
  await page.getByRole('button', { name: 'Collapse KINO Browser' }).click();
  await page.getByRole('button', { name: 'Expand KINO Browser' }).click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  if (process.env.CHAT_SCREENSHOT_PATH) await page.screenshot({ path: process.env.CHAT_SCREENSHOT_PATH });
  console.log('Chat UI checks passed: exact Markdown fixture, escaping, safe HTML/URLs, copy, multiline send, mode payloads, mobile layout, and scrolling.');
} finally {
  await browser.close();
}
