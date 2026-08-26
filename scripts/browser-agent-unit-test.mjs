import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { chromium } from "playwright";

import { observePage } from "../browser-worker/observer.ts";
import { developmentPrivateNetworkEscapeEnabled, isPrivateAddress, routedRequestProtocolPolicy, validatePublicUrl } from "../browser-worker/url-security.ts";
import { requestedBrowserUrl } from "../lib/kino/browser-worker/routing.ts";
import { formatBrowserToolResponse } from "../lib/kino/browser-worker/response.ts";
import { buildCriticalConfirmationPhrase, parseActionConfirmation } from "../lib/kino/web-agent/action-confirmation.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];

const publicUrl = await validatePublicUrl("https://example.com/path", { lookup: publicLookup });
assert.equal(publicUrl.allowed, true);
assert.equal(publicUrl.allowed && publicUrl.url.href, "https://example.com/path");
for (const value of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,x", "ftp://example.com"]) {
  assert.equal((await validatePublicUrl(value, { lookup: publicLookup })).allowed, false, value);
  assert.equal(routedRequestProtocolPolicy(value, true).allowed, false, value);
}
assert.deepEqual(routedRequestProtocolPolicy("data:image/png;base64,AA==", false), { allowed: true, validateNetworkTarget: false });
assert.equal(routedRequestProtocolPolicy("file:///etc/passwd", false).allowed, false);
assert.equal(routedRequestProtocolPolicy("ftp://example.com/resource", false).allowed, false);
for (const value of ["http://localhost", "http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254", "http://metadata.google.internal"]) {
  assert.equal((await validatePublicUrl(value)).allowed, false, value);
}
assert.equal((await validatePublicUrl("https://public.example", { lookup: privateLookup })).allowed, false);
// Redirect destinations pass through the same validator used by the worker route guard.
assert.equal((await validatePublicUrl("http://192.168.1.20/redirect-target")).allowed, false);
for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.2", "169.254.1.1", "::1", "fd00::1", "fe80::1"]) {
  assert.equal(isPrivateAddress(address), true, address);
}
const originalNodeEnvironment = process.env.NODE_ENV;
process.env.NODE_ENV = "production";
process.env.KINO_BROWSER_ALLOW_PRIVATE_NETWORKS = "true";
assert.equal(developmentPrivateNetworkEscapeEnabled(), false);
if (originalNodeEnvironment === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = originalNodeEnvironment;
delete process.env.KINO_BROWSER_ALLOW_PRIVATE_NETWORKS;
assert.equal(requestedBrowserUrl("Open https://example.com now"), "https://example.com");

const originalFetch = globalThis.fetch;
process.env.KINO_BROWSER_WORKER_URL = "https://worker.example";
process.env.KINO_BROWSER_WORKER_TOKEN = "unit-test-worker-token-123456";
let forwardedLoginBody = "";
globalThis.fetch = async (_url, init) => {
  forwardedLoginBody = String(init?.body ?? "");
  assert.equal(init?.headers?.Authorization, "Bearer unit-test-worker-token-123456");
  return new Response(JSON.stringify({ success: true, status: "AUTH_SUCCESS", message: "ok", authenticated: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
const { browserSessionId, loginBrowser, observeBrowser } = await import("../lib/kino/browser-worker/client.ts");
const loginResult = await loginBrowser("123e4567-e89b-42d3-a456-426614174000", {
  username: "secure-user@example.com",
  password: "test-only-secret",
});
assert.match(forwardedLoginBody, /secure-user@example\.com/);
assert.match(forwardedLoginBody, /test-only-secret/);
assert.equal(JSON.stringify(loginResult).includes("test-only-secret"), false);
globalThis.fetch = originalFetch;
delete process.env.KINO_BROWSER_WORKER_URL;
delete process.env.KINO_BROWSER_WORKER_TOKEN;
assert.equal(browserSessionId("123e4567-e89b-42d3-a456-426614174000"), null);
assert.equal((await observeBrowser("123e4567-e89b-42d3-a456-426614174000")).status, "WORKER_UNAVAILABLE");

const workerPort = 32_000 + Math.floor(Math.random() * 8_000);
const workerProcess = spawn(process.execPath, ["--experimental-strip-types", "browser-worker/server.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KINO_BROWSER_WORKER_HOST: "127.0.0.1",
    KINO_BROWSER_WORKER_PORT: String(workerPort),
    KINO_BROWSER_WORKER_TOKEN: "integration-worker-token-123456",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Browser worker did not start.")), 10_000);
    workerProcess.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Browser worker exited early (${code}).`));
    });
    workerProcess.stdout.once("data", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  const healthResponse = await fetch(`http://127.0.0.1:${workerPort}/health`);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: "ok", service: "kino-browser-worker" });
  const unauthorizedBody = JSON.stringify({ sessionId: "a".repeat(64) });
  const missingAuthorization = await fetch(`http://127.0.0.1:${workerPort}/browser/observe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: unauthorizedBody,
  });
  assert.equal(missingAuthorization.status, 401);
  const wrongAuthorization = await fetch(`http://127.0.0.1:${workerPort}/browser/observe`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong-token-value", "Content-Type": "application/json" },
    body: unauthorizedBody,
  });
  assert.equal(wrongAuthorization.status, 401);
} finally {
  workerProcess.kill();
  await new Promise((resolve) => workerProcess.once("exit", resolve));
}

// Development-only loopback browsing proves openUrl has no connection-registry dependency.
process.env.KINO_BROWSER_ALLOW_PRIVATE_NETWORKS = "true";
const testServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  if (request.url === "/next") {
    response.end("<title>Next area</title><h1>Semantic navigation completed</h1>");
  } else if (request.url === "/dynamic-write") {
    response.end(`<title>Dynamic write</title><h1>Customer editor</h1><p id="clock">Before</p><button type="submit" onclick="document.getElementById('clock').textContent='Unrelated dynamic text '+Date.now()">Save Customer</button>`);
  } else if (request.url === "/login") {
    response.end(`<title>Login</title><form onsubmit="event.preventDefault();document.body.innerHTML='<h1>Dashboard</h1><button>Log out</button>'"><label>Email <input type="email"></label><label>Password <input type="password"></label><button type="submit">Sign in</button></form>`);
  } else {
    response.end(`<title>Arbitrary test site</title><h1>Opened without a connection record</h1>
      <a href="/next">Next area</a>
      <a href="javascript:document.body.innerHTML='unsafe'">Unsafe JavaScript</a>
      <a href="data:text/html,unsafe">Unsafe data</a>
      <a href="file:///etc/passwd">Unsafe file</a>
      <a href="ftp://example.com/resource">Unsafe FTP</a>
      <label><input type="checkbox"> Receive updates</label>
      <button id="save" type="submit" onclick="document.body.innerHTML='<h1>Customer saved</h1>'">Save Customer</button>
      <button onclick="document.getElementById('save').outerHTML='<button id=&quot;save&quot; type=&quot;button&quot;>Changed Customer Control</button>'">View replacement</button>
      <button onclick="document.body.innerHTML='<div role=&quot;alert&quot;>Customer deleted successfully</div>'">Delete Customer</button>`);
  }
});
await new Promise((resolve) => testServer.listen(0, "127.0.0.1", resolve));
const address = testServer.address();
assert.ok(address && typeof address === "object");
const { closeSession, loginSession, observeSession, openUrl, performAction, shutdownBrowserForTests } = await import("../browser-worker/sessions.ts");
const arbitrarySessionId = "a".repeat(64);
const arbitraryOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
assert.equal(arbitraryOpen.success, true);
assert.equal(arbitraryOpen.status, "OPENED");
assert.equal(arbitraryOpen.observation?.title, "Arbitrary test site");
const nextLink = arbitraryOpen.observation?.elements.find((element) => element.name === "Next area");
assert.ok(nextLink);
const navigationResult = await performAction(arbitrarySessionId, { action: "click", elementId: nextLink.id });
assert.equal(navigationResult.status, "ACTION_COMPLETED");
assert.equal(navigationResult.observation?.title, "Next area");

for (const name of ["Unsafe JavaScript", "Unsafe data", "Unsafe file", "Unsafe FTP"]) {
  const unsafeOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
  const unsafeLink = unsafeOpen.observation?.elements.find((element) => element.name === name);
  assert.ok(unsafeLink);
  assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: unsafeLink.id })).status, "URL_BLOCKED", name);
}

const formOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
const saveButton = formOpen.observation?.elements.find((element) => element.name === "Save Customer");
assert.ok(saveButton);
const preparedWrite = await performAction(arbitrarySessionId, { action: "click", elementId: saveButton.id });
assert.equal(preparedWrite.status, "ACTION_NEEDS_CONFIRMATION");
assert.equal(preparedWrite.effectVerified, false);
const confirmedWrite = await performAction(arbitrarySessionId, { action: "confirm_pending", confirmation: "yes" });
assert.equal(confirmedWrite.status, "ACTION_COMPLETED");
assert.equal(confirmedWrite.effectVerified, true);
assert.ok(confirmedWrite.observation?.visibleText.includes("Customer saved"));

const checkboxOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
const checkbox = checkboxOpen.observation?.elements.find((element) => element.name === "Receive updates");
assert.ok(checkbox);
assert.equal((await performAction(arbitrarySessionId, { action: "check", elementId: checkbox.id })).status, "ACTION_NEEDS_CONFIRMATION");
const confirmedCheckbox = await performAction(arbitrarySessionId, { action: "confirm_pending", confirmation: "yes" });
assert.equal(confirmedCheckbox.status, "ACTION_COMPLETED");
assert.equal(confirmedCheckbox.observation?.elements.find((element) => element.name === "Receive updates")?.checked, true);

const criticalOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
const deleteButton = criticalOpen.observation?.elements.find((element) => element.name === "Delete Customer");
assert.ok(deleteButton);
const preparedCritical = await performAction(arbitrarySessionId, { action: "click", elementId: deleteButton.id });
assert.equal(preparedCritical.status, "ACTION_NEEDS_CONFIRMATION");
assert.equal(preparedCritical.pendingAction?.risk, "critical");
const confirmedCritical = await performAction(arbitrarySessionId, {
  action: "confirm_pending",
  confirmation: preparedCritical.pendingAction?.requiredConfirmationPhrase,
});
assert.equal(confirmedCritical.status, "ACTION_COMPLETED");
assert.equal(confirmedCritical.effectVerified, true);

const replacementOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
const replacementSave = replacementOpen.observation?.elements.find((element) => element.name === "Save Customer");
const replacementTrigger = replacementOpen.observation?.elements.find((element) => element.name === "View replacement");
assert.ok(replacementSave && replacementTrigger);
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: replacementSave.id })).status, "ACTION_NEEDS_CONFIRMATION");
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: replacementTrigger.id })).status, "ACTION_COMPLETED");
assert.equal((await performAction(arbitrarySessionId, { action: "confirm_pending", confirmation: "yes" })).status, "PAGE_CHANGED");

const dynamicOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}/dynamic-write`);
const dynamicSave = dynamicOpen.observation?.elements.find((element) => element.name === "Save Customer");
assert.ok(dynamicSave);
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: dynamicSave.id })).status, "ACTION_NEEDS_CONFIRMATION");
const unverifiedWrite = await performAction(arbitrarySessionId, { action: "confirm_pending", confirmation: "yes" });
assert.equal(unverifiedWrite.status, "ACTION_UNVERIFIED");
assert.equal(unverifiedWrite.effectVerified, false);
assert.match(formatBrowserToolResponse(unverifiedWrite), /activated, but completion could not be strongly verified/i);
assert.doesNotMatch(formatBrowserToolResponse(unverifiedWrite), /saved|submitted|updated|deleted|sent|refunded/i);

const loginOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}/login`);
assert.equal(loginOpen.status, "AUTH_REQUIRED");
const authenticated = await loginSession(arbitrarySessionId, "secure-user@example.com", "test-only-secret");
assert.equal(authenticated.status, "AUTH_SUCCESS");
assert.equal(JSON.stringify(authenticated).includes("test-only-secret"), false);
const retainedSession = await observeSession(arbitrarySessionId);
assert.equal(retainedSession.observation?.status, "OBSERVED");
assert.ok(retainedSession.observation?.visibleText.includes("Dashboard"));
await closeSession(arbitrarySessionId);
await shutdownBrowserForTests();
await new Promise((resolve, reject) => testServer.close((error) => error ? reject(error) : resolve()));
delete process.env.KINO_BROWSER_ALLOW_PRIVATE_NETWORKS;

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.setContent(`
    <main>
      <h1>Customer portal</h1>
      <a href="/customers">Customers</a>
      <button id="add">Add Customer</button>
      <label>Search customers <input type="search" placeholder="Search"></label>
      <button style="display:none">Hidden destructive control</button>
    </main>
  `);
  const registry = new Map();
  const observed = await observePage(page, registry);
  assert.equal(observed.status, "OBSERVED");
  assert.ok(observed.elements.some((element) => element.role === "link" && element.name === "Customers"));
  assert.ok(observed.elements.some((element) => element.role === "button" && element.name === "Add Customer"));
  assert.ok(observed.elements.some((element) => element.role === "searchbox" && /Search customers/i.test(element.name)));
  assert.equal(observed.elements.some((element) => /Hidden destructive/.test(element.name)), false);
  const customerLink = observed.elements.find((element) => element.name === "Customers");
  assert.ok(customerLink && /^e\d+$/.test(customerLink.id));
  assert.ok(registry.has(customerLink.id));

  await page.setContent(`<form><label>Email <input type="email"></label><label>Password <input type="password"></label><button>Sign in</button></form>`);
  const loginObservation = await observePage(page, registry);
  assert.equal(loginObservation.status, "AUTH_REQUIRED");
  assert.equal(loginObservation.authentication?.passwordField, true);

  await page.setContent(`<p>Enter the verification code from your authenticator</p><input inputmode="numeric">`);
  assert.equal((await observePage(page, registry)).status, "MFA_REQUIRED");
  await page.setContent(`<p>Verify you are human</p><iframe src="https://captcha.example"></iframe>`);
  assert.equal((await observePage(page, registry)).status, "CAPTCHA_REQUIRED");
  await context.close();
} finally {
  await browser.close();
}

const toolSource = readFileSync("lib/kino/tools/web-agent.ts", "utf8");
assert.match(toolSource, /name: "web_open_url"/);
assert.doesNotMatch(toolSource, /getConnectedSite/);
assert.doesNotMatch(toolSource, /\b(?:selector|xpath)\s*:/i);
assert.doesNotMatch(toolSource, /username|password/);
assert.match(toolSource, /\^e\\d\+\$/);

const controllerSource = readFileSync("app/api/kino/route.ts", "utf8");
assert.doesNotMatch(controllerSource, /playwright|browser-manager/);
assert.doesNotMatch(controllerSource, /loginBrowser/);
assert.match(controllerSource, /MAX_BROWSER_STEPS/);
assert.match(controllerSource, /duplicateActions/);
assert.match(controllerSource, /actionHistory/);
assert.match(controllerSource, /toolCalls\.slice\(0, 1\)/);
const toolsIndexSource = readFileSync("lib/kino/tools/index.ts", "utf8");
assert.doesNotMatch(toolsIndexSource, /playwright|browser-manager/);

const loginRouteSource = readFileSync("app/api/kino/browser-login/route.ts", "utf8");
assert.doesNotMatch(loginRouteSource, /console\.(?:log|info|error).*username|console\.(?:log|info|error).*password/);
assert.match(loginRouteSource, /loginBrowser/);
const workerSource = readFileSync("browser-worker/sessions.ts", "utf8");
assert.match(workerSource, /username = ""/);
assert.match(workerSource, /password = ""/);
assert.match(workerSource, /liveAccessibleName/);
assert.match(workerSource, /pageSignature/);
assert.match(workerSource, /effectVerified/);
assert.doesNotMatch(workerSource, /role: "button", name: pending/);
assert.match(workerSource, /pendingElementStillMatches/);
assert.match(workerSource, /ACTION_UNVERIFIED/);
const workerServerSource = readFileSync("browser-worker/server.ts", "utf8");
assert.match(workerServerSource, /timingSafeEqual/);
assert.match(workerServerSource, /service: "kino-browser-worker"/);
assert.doesNotMatch(workerServerSource, /activeSessions/);
assert.doesNotMatch(workerServerSource, /console\.(?:log|info|error).*authorization/i);
const workerClientSource = readFileSync("lib/kino/browser-worker/client.ts", "utf8");
assert.doesNotMatch(workerClientSource, /local-unconfigured-worker/);
const loginSection = workerSource.slice(
  workerSource.indexOf("export async function loginSession"),
  workerSource.indexOf("export async function closeSession"),
);
assert.match(loginSection, /AUTH_SUCCESS/);
assert.doesNotMatch(loginSection, /context\.close|closeSession/);

const criticalPhrase = buildCriticalConfirmationPhrase("Delete Customer");
assert.equal(parseActionConfirmation({ message: "yes", risk: "critical", requiredPhrase: criticalPhrase }).explicit, false);
assert.equal(parseActionConfirmation({ message: criticalPhrase, risk: "critical", requiredPhrase: criticalPhrase }).explicit, true);

console.log("Generic browser-agent unit tests passed.");
