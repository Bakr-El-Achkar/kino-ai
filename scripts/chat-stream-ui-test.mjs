import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Controlled native ReadableStreams exercise the real page without contacting a model/worker.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
await page.addInitScript(() => {
  const originalFetch = window.fetch.bind(window);
  window.chatFixture = { requests: [], aborted: false };
  window.fetch = async (url, init) => {
    if (url === '/api/kino/browser-state') return Response.json({ active: false, status: 'SESSION_EXPIRED' });
    if (url !== '/api/kino') return originalFetch(url, init);
    const fixture = window.chatFixture;
    fixture.requests.push(JSON.parse(init.body));
    fixture.aborted = false;
    return new Response(new ReadableStream({
      start(controller) {
        fixture.emit = event => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + '\n'));
        fixture.close = () => controller.close();
        init.signal.addEventListener('abort', () => { fixture.aborted = true; }, { once: true });
      },
      cancel() { fixture.cancelled = true; },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  };
});
const emit = event => page.evaluate(event => window.chatFixture.emit(event), event);
try {
  await page.goto(process.env.CHAT_TEST_URL || 'http://localhost:3100');
  const input = page.getByRole('textbox', { name: 'Message KINO', exact: true });
  assert.equal(await page.locator('.send-arrow').textContent(), '\u2191');
  await page.locator('.composer-modes').getByRole('button', { name: 'THINK' }).click();
  await input.fill('Explain');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Stop response' }).waitFor();
  await emit({ type: 'start' });
  assert.match(await page.locator('.chat-working').textContent(), /Reasoning deeply/);
  assert.equal(await page.locator('.chat-row-kino').count(), 0);
  await emit({ type: 'status', kind: 'browser', label: 'Opening tailscale.com' });
  await page.getByRole('status').filter({ hasText: 'Opening tailscale.com' }).waitFor();
  await emit({ type: 'status', kind: 'reading', label: 'Reading tailscale.com' });
  await page.getByRole('status').filter({ hasText: 'Reading tailscale.com' }).waitFor();
  assert.equal(await page.locator('.chat-working').count(), 1);
  assert.equal(await page.getByText('Opening tailscale.com', { exact: true }).count(), 0);
  await emit({ type: 'delta', content: '**Hel' });
  await page.locator('.chat-markdown').filter({ hasText: 'Hel' }).waitFor();
  assert.equal(await page.locator('.chat-working').count(), 0);
  await emit({ type: 'status', kind: 'reading', label: 'Reading page...' });
  assert.equal(await page.locator('.chat-working').count(), 0);
  assert.equal(await page.locator('.chat-row-kino').count(), 1);
  await emit({ type: 'delta', content: 'lo**\n\n```javascript\nconsole.' });
  await page.locator('.chat-markdown strong').waitFor();
  assert.equal(await page.locator('.chat-markdown strong').textContent(), 'Hello');
  await emit({ type: 'delta', content: 'log("KINO");\n```\n\n' + 'A paragraph with some space.\n\n'.repeat(45) });
  await page.waitForFunction(() => { const el = document.querySelector('.chat-workspace'); return el.scrollHeight > el.clientHeight * 2 && el.scrollHeight - el.scrollTop - el.clientHeight < 140; });
  await page.locator('.chat-workspace').hover();
  await page.mouse.wheel(0, -1400);
  await page.waitForTimeout(300);
  const top = await page.locator('.chat-workspace').evaluate(el => el.scrollTop);
  await emit({ type: 'delta', content: '\n\nMore streamed text.\n'.repeat(10) });
  await page.waitForTimeout(150);
  assert.ok(Math.abs(await page.locator('.chat-workspace').evaluate(el => el.scrollTop) - top) < 5, 'Streaming forced upward reader to bottom');
  await emit({ type: 'error', code: 'STREAM_INTERRUPTED', message: 'Safe fixture error' });
  await page.getByRole('button', { name: 'Send message' }).waitFor();
  assert.equal(await page.locator('.chat-row-kino').count(), 1, 'Error duplicated assistant');
  assert.equal(await page.locator('.chat-markdown strong').textContent(), 'Hello');
  assert.match(await page.locator('.chat-error').textContent(), /kept/);
  assert.equal(await page.evaluate(() => window.chatFixture.requests.length), 1, 'Unexpected retry');

  await page.locator('.composer-modes').getByRole('button', { name: 'FAST' }).click();
  await input.fill('Second request');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Stop response' }).waitFor();
  await emit({ type: 'start' });
  assert.match(await page.locator('.chat-working').textContent(), /Working/);
  await emit({ type: 'delta', content: 'Partial answer' });
  await page.locator('.chat-markdown').filter({ hasText: 'Partial answer' }).waitFor();
  await page.getByRole('button', { name: 'Stop response' }).click();
  await page.getByRole('button', { name: 'Send message' }).waitFor();
  assert.equal(await page.evaluate(() => window.chatFixture.aborted), true);
  assert.equal(await page.evaluate(() => window.chatFixture.cancelled), true);
  assert.equal(await page.locator('.chat-row-kino').count(), 2);
  assert.equal(await page.locator('.chat-markdown').last().textContent(), 'Partial answer');
  assert.equal(await page.locator('.chat-error').count(), 0);
  const requests = await page.evaluate(() => window.chatFixture.requests);
  assert.deepEqual(requests.map(request => request.reasoningMode), ['thinking', 'normal']);
  assert.ok(requests[1].messages.some(message => message.content.startsWith('**Hello**')));

  await input.fill('Finish normally');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Stop response' }).waitFor();
  await emit({ type: 'start' });
  await emit({ type: 'delta', content: 'Final ' });
  await emit({ type: 'delta', content: 'answer.' });
  await emit({ type: 'done' });
  await page.getByRole('button', { name: 'Send message' }).waitFor();
  assert.equal(await page.locator('.chat-markdown').last().textContent(), 'Final answer.');
  assert.equal(await page.locator('.chat-row-kino').count(), 3);
  await input.fill('Mixed tool response');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Stop response' }).waitFor();
  await emit({ type: 'start' });
  await emit({ type: 'delta', content: 'Checking the page...' });
  await page.locator('.chat-markdown').filter({ hasText: 'Checking the page...' }).waitFor();
  await emit({ type: 'reset' });
  await page.locator('.chat-working').waitFor();
  assert.equal(await page.locator('.chat-row-kino').count(), 3, 'Provisional tool text remained visible');
  await emit({ type: 'delta', content: 'Verified result' });
  await emit({ type: 'done' });
  await page.getByRole('button', { name: 'Send message' }).waitFor();
  assert.equal(await page.locator('.chat-row-kino').count(), 4, 'Reset duplicated the assistant message');
  assert.equal(await page.locator('.chat-markdown').last().textContent(), 'Verified result');
  await input.fill('Navigation cancellation');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Stop response' }).waitFor();
  await emit({ type: 'start' });
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.getByRole('button', { name: 'Send message' }).waitFor();
  assert.equal(await page.evaluate(() => window.chatFixture.aborted), true);
  assert.equal(await page.locator('.chat-row-kino').count(), 4, 'Empty cancelled response remained');
  console.log('Streaming browser checks passed: incremental Markdown, THINK/FAST status, upward scroll, error retention, one message per response, Stop, and history.');
} finally { await browser.close(); }
