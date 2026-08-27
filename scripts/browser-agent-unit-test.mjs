import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { chromium } from "playwright";

import { observePage } from "../browser-worker/observer.ts";
import { developmentPrivateNetworkEscapeEnabled, isPrivateAddress, routedRequestProtocolPolicy, validatePublicUrl } from "../browser-worker/url-security.ts";
import { requestedBrowserUrl } from "../lib/kino/browser-worker/routing.ts";
import { shouldContinueSafeBrowserNarration } from "../lib/kino/browser-worker/continuation.ts";
import { ollamaHttpErrorDiagnostics, ollamaRequestDiagnostics } from "../lib/kino/ollama/http-error-diagnostics.ts";
import { buildQwenAgentTranscript, internalContinuationDirective, isInternalContinuationDirective, transcriptShape } from "../lib/kino/ollama/transcript.ts";
import { isTransientAiTransportError, safeErrorDiagnostics, withTransientAiTransportRetry } from "../lib/kino/ollama/transport-retry.ts";
import { formatBrowserToolResponse } from "../lib/kino/browser-worker/response.ts";
import { buildCriticalConfirmationPhrase, parseActionConfirmation } from "../lib/kino/web-agent/action-confirmation.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
const privateLookup = async () => [{ address: "10.0.0.5", family: 4 }];

const activeBrowserGoal = "Open website A, then open page B and tell me about it.";
const visibleTranscript = [{ role: "user", content: activeBrowserGoal }];
const toolHistory = [];
const modelCallOne = buildQwenAgentTranscript({
  systemMessage: "KINO system",
  visibleConversation: visibleTranscript,
  toolTranscript: toolHistory,
  activeUserGoal: activeBrowserGoal,
});
assert.deepEqual(transcriptShape(modelCallOne, activeBrowserGoal), {
  roles: ["system", "user"],
  messageCount: 2,
  activeUserGoalPresent: true,
});

toolHistory.push(
  { role: "assistant", content: "", tool_calls: [{ function: { name: "web_open_url", arguments: {} } }] },
  { role: "tool", tool_name: "web_open_url", content: JSON.stringify({ status: "OPENED", observation: "site A" }) },
);
const modelCallTwo = buildQwenAgentTranscript({
  systemMessage: "KINO system",
  visibleConversation: visibleTranscript,
  toolTranscript: toolHistory,
  activeUserGoal: activeBrowserGoal,
  continuationReason: "TOOL_RESULT",
});
assert.deepEqual(transcriptShape(modelCallTwo, activeBrowserGoal), {
  roles: ["system", "user", "assistant", "tool", "user"],
  messageCount: 5,
  activeUserGoalPresent: true,
});
assert.equal(isInternalContinuationDirective(modelCallTwo.at(-1)), true);
assert.match(modelCallTwo.at(-1).content, /answer the user from the existing trusted results without another tool call/i);

toolHistory.push(
  { role: "assistant", content: "", tool_calls: [{ function: { name: "web_action", arguments: { elementId: "e7" } } }] },
  { role: "tool", tool_name: "web_action", content: JSON.stringify({ status: "ACTION_COMPLETED", observation: "page B" }) },
);
const modelCallThree = buildQwenAgentTranscript({
  systemMessage: "KINO system",
  visibleConversation: visibleTranscript,
  toolTranscript: toolHistory,
  activeUserGoal: activeBrowserGoal,
  continuationReason: "TOOL_RESULT",
});
assert.deepEqual(transcriptShape(modelCallThree, activeBrowserGoal), {
  roles: ["system", "user", "assistant", "tool", "assistant", "tool", "user"],
  messageCount: 7,
  activeUserGoalPresent: true,
});
assert.equal(modelCallThree.at(-2).role, "tool");
assert.match(modelCallThree.at(-2).content, /page B/);

toolHistory.push(
  { role: "assistant", content: "", tool_calls: [{ function: { name: "web_action", arguments: { elementId: "e11" } } }] },
  { role: "tool", tool_name: "web_action", content: JSON.stringify({ status: "ACTION_COMPLETED", observation: "page C" }) },
);
const modelCallFour = buildQwenAgentTranscript({
  systemMessage: "KINO system",
  visibleConversation: visibleTranscript,
  toolTranscript: toolHistory,
  activeUserGoal: activeBrowserGoal,
  continuationReason: "TOOL_RESULT",
});
assert.equal(transcriptShape(modelCallFour, activeBrowserGoal).activeUserGoalPresent, true);
assert.deepEqual(modelCallFour.slice(-3).map((message) => message.role), ["assistant", "tool", "user"]);

const internalDirective = internalContinuationDirective(activeBrowserGoal, "NARRATED_SAFE_STEP");
assert.equal(parseActionConfirmation({ message: internalDirective.content, risk: "write" }).explicit, false);
assert.match(internalDirective.content, /not user confirmation/i);
assert.deepEqual(visibleTranscript, [{ role: "user", content: activeBrowserGoal }]);
assert.equal(toolHistory.some(isInternalContinuationDirective), false);
assert.equal(modelCallThree.filter(isInternalContinuationDirective).length, 1);
assert.equal(toolHistory.filter((message) => message.role === "tool").length, 3);

const ordinaryAiTranscript = buildQwenAgentTranscript({
  systemMessage: "KINO system",
  visibleConversation: [{ role: "user", content: "Explain photosynthesis." }],
  toolTranscript: [],
  activeUserGoal: "Explain photosynthesis.",
});
assert.deepEqual(ordinaryAiTranscript, [
  { role: "system", content: "KINO system" },
  { role: "user", content: "Explain photosynthesis." },
]);

const retrySignal = new AbortController().signal;
const retryOptions = () => ({ signal: retrySignal, startedAt: Date.now(), maxRuntimeMs: 10_000, backoffMs: 0 });
let normalModelCalls = 0;
assert.equal(await withTransientAiTransportRetry(async () => {
  normalModelCalls += 1;
  return "normal-model-response";
}, retryOptions()), "normal-model-response");
assert.equal(normalModelCalls, 1);

let continuationModelCalls = 0;
const completedToolTranscript = [{ role: "tool", content: JSON.stringify({ status: "ACTION_COMPLETED" }) }];
const completedBrowserActions = 1;
const recoveredContinuation = await withTransientAiTransportRetry(async () => {
  continuationModelCalls += 1;
  assert.equal(completedToolTranscript.length, 1);
  if (continuationModelCalls === 1) throw new Error("terminated");
  return "final synthesis recovered";
}, retryOptions());
assert.equal(recoveredContinuation, "final synthesis recovered");
assert.equal(continuationModelCalls, 2);
assert.equal(completedBrowserActions, 1);

const writeExecutions = 1;
let writeSynthesisCalls = 0;
assert.equal(await withTransientAiTransportRetry(async () => {
  writeSynthesisCalls += 1;
  if (writeSynthesisCalls === 1) throw new Error("socket closed");
  return "write result summarized";
}, retryOptions()), "write result summarized");
assert.equal(writeExecutions, 1);
assert.equal(writeSynthesisCalls, 2);

let repeatedFailures = 0;
await assert.rejects(withTransientAiTransportRetry(async () => {
  repeatedFailures += 1;
  throw new Error("terminated");
}, retryOptions()), /terminated/);
assert.equal(repeatedFailures, 2);

let expiredRuntimeCalls = 0;
await assert.rejects(withTransientAiTransportRetry(async () => {
  expiredRuntimeCalls += 1;
  throw new Error("terminated");
}, { signal: retrySignal, startedAt: Date.now() - 10_000, maxRuntimeMs: 10_000, backoffMs: 0 }), /terminated/);
assert.equal(expiredRuntimeCalls, 1);

let authenticationCalls = 0;
await assert.rejects(withTransientAiTransportRetry(async () => {
  authenticationCalls += 1;
  throw new Error("Ollama returned HTTP 401.");
}, retryOptions()), /HTTP 401/);
assert.equal(authenticationCalls, 1);
assert.equal(isTransientAiTransportError(new Error("WORKER_UNAVAILABLE")), false);
assert.equal(isTransientAiTransportError(new DOMException("cancelled", "AbortError")), false);
const ollamaApplicationError = new Error("terminated");
ollamaApplicationError.name = "OllamaApplicationError";
assert.equal(isTransientAiTransportError(ollamaApplicationError), false);
const socketError = new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) });
assert.equal(isTransientAiTransportError(socketError), true);
assert.deepEqual(Object.keys(safeErrorDiagnostics(socketError)), ["errorName", "errorMessage", "causeName", "causeMessage", "causeCode"]);
const redactedDiagnostics = safeErrorDiagnostics(new Error("failed at https://private.example/path with Bearer secret-value"));
assert.doesNotMatch(JSON.stringify(redactedDiagnostics), /private\.example|secret-value/);

const actualDiagnosticRequestOptions = { num_ctx: 8192, num_predict: 1024 };
const diagnosticRequest = JSON.stringify({
  messages: [{ role: "user", content: "diagnostic request" }],
  tools: [{ type: "function" }],
  options: actualDiagnosticRequestOptions,
});
const jsonHttpDiagnostics = await ollamaHttpErrorDiagnostics(new Response(
  JSON.stringify({ error: "plain failure", ignored: "must not be copied" }),
  { status: 500, statusText: "Internal Server Error", headers: { "Content-Type": "application/json" } },
), {
  serializedRequest: diagnosticRequest,
  messages: [{ content: "diagnostic request" }],
  toolDefinitionCount: 1,
  requestOptions: actualDiagnosticRequestOptions,
});
assert.equal(jsonHttpDiagnostics.upstreamStatus, 500);
assert.equal(jsonHttpDiagnostics.ollamaError, "plain failure");
assert.equal(jsonHttpDiagnostics.messageCount, 1);
assert.equal(jsonHttpDiagnostics.toolDefinitionCount, 1);
assert.equal(jsonHttpDiagnostics.messageContentCharacters, "diagnostic request".length);
assert.equal(jsonHttpDiagnostics.configuredNumCtx, actualDiagnosticRequestOptions.num_ctx);
assert.equal(jsonHttpDiagnostics.configuredNumPredict, actualDiagnosticRequestOptions.num_predict);
assert.doesNotMatch(JSON.stringify(jsonHttpDiagnostics), /must not be copied/);

const objectHttpDiagnostics = await ollamaHttpErrorDiagnostics(new Response(JSON.stringify({ error: {
  message: "context exceeded",
  code: "MODEL_CONTEXT_LIMIT",
  type: "runner_error",
  status: false,
  status_code: 500,
  reason: "input too large",
  unknown: "UNKNOWN_FIELD_MUST_NOT_APPEAR",
  details: { private: "NESTED_PRIVATE_VALUE" },
} }), { status: 500, headers: { "Content-Type": "application/json" } }), {
  serializedRequest: diagnosticRequest,
  messages: [{ content: "diagnostic request" }],
  toolDefinitionCount: 1,
  requestOptions: actualDiagnosticRequestOptions,
});
assert.equal(objectHttpDiagnostics.ollamaError, undefined);
assert.equal(objectHttpDiagnostics.ollamaErrorMessage, "context exceeded");
assert.equal(objectHttpDiagnostics.ollamaErrorCode, "MODEL_CONTEXT_LIMIT");
assert.equal(objectHttpDiagnostics.ollamaErrorType, "runner_error");
assert.equal(objectHttpDiagnostics.ollamaErrorStatus, false);
assert.equal(objectHttpDiagnostics.ollamaErrorStatusCode, 500);
assert.equal(objectHttpDiagnostics.ollamaErrorReason, "input too large");
assert.doesNotMatch(JSON.stringify(objectHttpDiagnostics), /UNKNOWN_FIELD_MUST_NOT_APPEAR|NESTED_PRIVATE_VALUE|unknown|details/);

const invalidTranscriptDiagnostics = await ollamaHttpErrorDiagnostics(new Response(JSON.stringify({ error: {
  code: 500,
  message: "Jinja Exception: No user query found in messages.",
  type: "server_error",
} }), { status: 500, headers: { "Content-Type": "application/json" } }), {
  serializedRequest: diagnosticRequest,
  messages: [{ content: "diagnostic request" }],
  toolDefinitionCount: 1,
});
assert.equal(invalidTranscriptDiagnostics.modelErrorClassification, "MODEL_TRANSCRIPT_INVALID");
const invalidTranscriptError = Object.assign(new Error("The model rejected the internal transcript."), {
  name: "ModelTranscriptInvalidError",
  code: "MODEL_TRANSCRIPT_INVALID",
});
assert.equal(isTransientAiTransportError(invalidTranscriptError), false);

const ignoredNestedScalars = await ollamaHttpErrorDiagnostics(new Response(JSON.stringify({ error: {
  message: { text: "hidden nested message" },
  code: ["hidden array code"],
  type: null,
} }), { status: 500, headers: { "Content-Type": "application/json" } }), {
  serializedRequest: "{}",
  messages: [],
  toolDefinitionCount: 0,
});
assert.equal(ignoredNestedScalars.ollamaErrorMessage, undefined);
assert.equal(ignoredNestedScalars.ollamaErrorCode, undefined);
assert.equal(ignoredNestedScalars.ollamaErrorType, undefined);
assert.doesNotMatch(JSON.stringify(ignoredNestedScalars), /hidden nested message|hidden array code/);

const rawPrivateBody = "RAW_NON_JSON_PRIVATE_BODY";
const nonJsonHttpDiagnostics = await ollamaHttpErrorDiagnostics(new Response(rawPrivateBody, {
  status: 500,
  headers: { "Content-Type": "text/plain" },
}), { serializedRequest: "{}", messages: [], toolDefinitionCount: 0 });
assert.equal(nonJsonHttpDiagnostics.ollamaError, undefined);
assert.doesNotMatch(JSON.stringify(nonJsonHttpDiagnostics), new RegExp(rawPrivateBody));

const privatePrompt = "PRIVATE_PROMPT_CONTENT_12345";
const privateAuthorization = "private-authorization-token-67890";
const privateErrorDiagnostics = await ollamaHttpErrorDiagnostics(new Response(JSON.stringify({
  error: {
    message: `runner failed for ${privatePrompt}`,
    code: `Bearer ${privateAuthorization}`,
  },
}), { status: 500, headers: { "Content-Type": "application/problem+json" } }), {
  serializedRequest: JSON.stringify({ messages: [{ content: privatePrompt }] }),
  messages: [{ content: privatePrompt }],
  toolDefinitionCount: 0,
  secrets: [privateAuthorization],
});
assert.doesNotMatch(JSON.stringify(privateErrorDiagnostics), new RegExp(`${privatePrompt}|${privateAuthorization}`));

const longErrorDiagnostics = await ollamaHttpErrorDiagnostics(new Response(JSON.stringify({ error: "x".repeat(900) }), {
  status: 500,
  headers: { "Content-Type": "application/json" },
}), { serializedRequest: "{}", messages: [], toolDefinitionCount: 0 });
assert.ok(longErrorDiagnostics.ollamaError && longErrorDiagnostics.ollamaError.length <= 500);
const longObjectErrorDiagnostics = await ollamaHttpErrorDiagnostics(new Response(JSON.stringify({ error: {
  message: "m".repeat(900),
  reason: "r".repeat(900),
} }), { status: 500, headers: { "Content-Type": "application/json" } }), {
  serializedRequest: "{}",
  messages: [],
  toolDefinitionCount: 0,
});
assert.ok(typeof longObjectErrorDiagnostics.ollamaErrorMessage === "string" && longObjectErrorDiagnostics.ollamaErrorMessage.length <= 500);
assert.ok(typeof longObjectErrorDiagnostics.ollamaErrorReason === "string" && longObjectErrorDiagnostics.ollamaErrorReason.length <= 500);
assert.equal(ollamaRequestDiagnostics("é", [], 0).requestBytes, 2);

let http500Calls = 0;
const deterministicHttp500 = new Error("Ollama returned HTTP 500.");
deterministicHttp500.name = "OllamaHttpError";
await assert.rejects(withTransientAiTransportRetry(async () => {
  http500Calls += 1;
  throw deterministicHttp500;
}, retryOptions()), /HTTP 500/);
assert.equal(http500Calls, 1);

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

const workerPreviewServer = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(`<title>Screenshot integration</title><h1>KINO Browser frame</h1><label>Password <input type="password" value="must-never-appear"></label><label>OTP <input autocomplete="one-time-code" value="123456"></label><a href="/next">Next</a>`);
});
await new Promise((resolve) => workerPreviewServer.listen(0, "127.0.0.1", resolve));
const workerPreviewAddress = workerPreviewServer.address();
assert.ok(workerPreviewAddress && typeof workerPreviewAddress === "object");
const workerPort = 32_000 + Math.floor(Math.random() * 8_000);
const workerProcess = spawn(process.execPath, ["--experimental-strip-types", "browser-worker/server.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KINO_BROWSER_WORKER_HOST: "127.0.0.1",
    KINO_BROWSER_WORKER_PORT: String(workerPort),
    KINO_BROWSER_WORKER_TOKEN: "integration-worker-token-123456",
    KINO_BROWSER_ALLOW_PRIVATE_NETWORKS: "true",
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
  const missingScreenshotAuthorization = await fetch(`http://127.0.0.1:${workerPort}/browser/screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: unauthorizedBody,
  });
  assert.equal(missingScreenshotAuthorization.status, 401);

  const workerHeaders = { Authorization: "Bearer integration-worker-token-123456", "Content-Type": "application/json" };
  const unknownScreenshot = await fetch(`http://127.0.0.1:${workerPort}/browser/screenshot`, {
    method: "POST",
    headers: workerHeaders,
    body: unauthorizedBody,
  });
  assert.equal(unknownScreenshot.status, 409);
  assert.equal((await unknownScreenshot.json()).status, "SESSION_EXPIRED");

  const screenshotSessionId = "b".repeat(64);
  const workerOpen = await fetch(`http://127.0.0.1:${workerPort}/browser/open`, {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ sessionId: screenshotSessionId, url: `http://127.0.0.1:${workerPreviewAddress.port}` }),
  });
  assert.equal(workerOpen.status, 200);
  const workerState = await fetch(`http://127.0.0.1:${workerPort}/browser/state`, {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ sessionId: screenshotSessionId }),
  });
  const workerStateBody = await workerState.json();
  assert.equal(workerStateBody.active, true);
  assert.equal(workerStateBody.title, "Screenshot integration");
  const screenshotResponse = await fetch(`http://127.0.0.1:${workerPort}/browser/screenshot`, {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ sessionId: screenshotSessionId }),
  });
  assert.equal(screenshotResponse.status, 200);
  assert.equal(screenshotResponse.headers.get("content-type"), "image/jpeg");
  assert.equal(screenshotResponse.headers.get("cache-control"), "no-store, private");
  const screenshotBytes = new Uint8Array(await screenshotResponse.arrayBuffer());
  assert.ok(screenshotBytes.byteLength > 1_000);
  assert.equal(screenshotBytes[0], 0xff);
  assert.equal(screenshotBytes[1], 0xd8);
  assert.equal(Buffer.from(screenshotBytes).includes(Buffer.from("integration-worker-token-123456")), false);
  await fetch(`http://127.0.0.1:${workerPort}/browser/close`, {
    method: "POST",
    headers: workerHeaders,
    body: JSON.stringify({ sessionId: screenshotSessionId }),
  });
} finally {
  workerProcess.kill();
  await new Promise((resolve) => workerProcess.once("exit", resolve));
  await new Promise((resolve, reject) => workerPreviewServer.close((error) => error ? reject(error) : resolve()));
}

// Development-only loopback browsing proves openUrl has no connection-registry dependency.
process.env.KINO_BROWSER_ALLOW_PRIVATE_NETWORKS = "true";
const testServer = createServer((request, response) => {
  response.writeHead(200, {
    "Content-Type": "text/html",
    ...(request.url === "/runtime-file" ? { "Content-Disposition": "attachment; filename=report.bin" } : {}),
  });
  if (request.url === "/next") {
    response.end("<title>Next area</title><h1>Semantic navigation completed</h1>");
  } else if (request.url === "/alpha") {
    response.end("<title>Alpha target</title><h1>Correct alpha destination</h1>");
  } else if (request.url === "/beta") {
    response.end("<title>Beta target</title><h1>Wrong beta destination</h1>");
  } else if (request.url === "/blocked-navigation") {
    response.end(`<title>Blocked navigation test</title><a href="/alpha" onclick="event.preventDefault()">Open Alpha</a>`);
  } else if (request.url === "/downloads") {
    response.end(`<title>Downloads</title><a download href="/archive.bin">Download archive</a><a href="/runtime-file">Get report</a>`);
  } else if (request.url === "/archive.bin") {
    response.end("not downloaded");
  } else if (request.url === "/runtime-file") {
    response.end("not retained");
  } else if (request.url === "/reorder-move") {
    response.end(`<title>Move controls</title><div id="links"><a id="alpha" href="/alpha">Alpha game</a><a id="beta" href="/beta">Beta game</a></div><script>setTimeout(()=>document.getElementById('links').append(document.getElementById('alpha')),750)</script>`);
  } else if (request.url === "/reorder-replace") {
    response.end(`<title>Replace controls</title><div id="links"><a id="alpha" href="/alpha">Alpha game</a><a href="/beta">Beta game</a></div><script>setTimeout(()=>document.getElementById('alpha').outerHTML='<a href="/beta">Alpha game</a>',750)</script>`);
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
      <a href="/alpha">Delete account</a>
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
assert.match(formatBrowserToolResponse(arbitraryOpen), /Opened in KINO Browser/);
assert.doesNotMatch(formatBrowserToolResponse(arbitraryOpen), /your (?:computer|browser)|local (?:window|tab)/i);
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
assert.equal((await performAction(arbitrarySessionId, { action: "confirm_pending", confirmation: "yes" })).status, "STALE_ELEMENT");

const dynamicOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}/dynamic-write`);
const dynamicSave = dynamicOpen.observation?.elements.find((element) => element.name === "Save Customer");
assert.ok(dynamicSave);
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: dynamicSave.id })).status, "ACTION_NEEDS_CONFIRMATION");
const unverifiedWrite = await performAction(arbitrarySessionId, { action: "confirm_pending", confirmation: "yes" });
assert.equal(unverifiedWrite.status, "ACTION_UNVERIFIED");
assert.equal(unverifiedWrite.effectVerified, false);
assert.match(formatBrowserToolResponse(unverifiedWrite), /activated, but completion could not be strongly verified/i);
assert.doesNotMatch(formatBrowserToolResponse(unverifiedWrite), /saved|submitted|updated|deleted|sent|refunded/i);

// Normal links are explicit read navigation, while failed verification remains read-specific.
const blockedNavigationOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}/blocked-navigation`);
const blockedNavigationLink = blockedNavigationOpen.observation?.elements.find((element) => element.name === "Open Alpha");
assert.ok(blockedNavigationLink);
const blockedNavigation = await performAction(arbitrarySessionId, { action: "click", elementId: blockedNavigationLink.id });
assert.equal(blockedNavigation.status, "NAVIGATION_UNVERIFIED");
assert.equal(blockedNavigation.pendingAction, undefined);
assert.equal(blockedNavigation.effectVerified, false);

// Known and runtime-discovered downloads are never saved or treated as ordinary navigation.
const downloadOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}/downloads`);
const declaredDownload = downloadOpen.observation?.elements.find((element) => element.name === "Download archive");
const runtimeDownload = downloadOpen.observation?.elements.find((element) => element.name === "Get report");
assert.ok(declaredDownload && runtimeDownload);
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: declaredDownload.id })).status, "DOWNLOAD_REQUIRES_HANDLING");
const runtimeDownloadResult = await performAction(arbitrarySessionId, { action: "click", elementId: runtimeDownload.id });
assert.equal(runtimeDownloadResult.status, "DOWNLOAD_REQUIRES_HANDLING");
assert.equal(runtimeDownloadResult.success, false);

// Registry refreshes allocate new capabilities and deterministically retire old IDs.
const refreshOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
const oldRefreshLink = refreshOpen.observation?.elements.find((element) => element.name === "Next area");
assert.ok(oldRefreshLink);
const refreshedState = await observeSession(arbitrarySessionId);
const newRefreshLink = refreshedState.observation?.elements.find((element) => element.name === "Next area");
assert.ok(newRefreshLink);
assert.notEqual(newRefreshLink.id, oldRefreshLink.id);
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: oldRefreshLink.id })).status, "STALE_ELEMENT");
assert.equal((await observeSession(arbitrarySessionId)).status, "OBSERVED");

// Scroll/re-observe never lets an earlier ID silently point at a different control.
const scrollOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
const preScrollLink = scrollOpen.observation?.elements.find((element) => element.name === "Next area");
assert.ok(preScrollLink);
assert.equal((await performAction(arbitrarySessionId, { action: "scroll", direction: "down" })).status, "ACTION_COMPLETED");
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: preScrollLink.id })).status, "STALE_ELEMENT");

// Navigation invalidates every capability from the previous document.
const oldPageOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
const oldPageLink = oldPageOpen.observation?.elements.find((element) => element.name === "Next area");
const oldPageCheckbox = oldPageOpen.observation?.elements.find((element) => element.name === "Receive updates");
assert.ok(oldPageLink && oldPageCheckbox);
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: oldPageLink.id })).status, "ACTION_COMPLETED");
assert.equal((await performAction(arbitrarySessionId, { action: "check", elementId: oldPageCheckbox.id })).status, "STALE_ELEMENT");

// A moved DOM node retains its own handle; a replaced node is rejected rather than retargeted.
const moveOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}/reorder-move`);
const movingAlpha = moveOpen.observation?.elements.find((element) => element.name === "Alpha game");
assert.ok(movingAlpha);
await new Promise((resolve) => setTimeout(resolve, 900));
const movedResult = await performAction(arbitrarySessionId, { action: "click", elementId: movingAlpha.id });
assert.equal(movedResult.status, "ACTION_COMPLETED");
assert.equal(movedResult.observation?.title, "Alpha target");

const replaceOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}/reorder-replace`);
const replacedAlpha = replaceOpen.observation?.elements.find((element) => element.name === "Alpha game");
assert.ok(replacedAlpha);
await new Promise((resolve) => setTimeout(resolve, 900));
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: replacedAlpha.id })).status, "STALE_ELEMENT");

// Broad user wording never pre-authorizes a write or satisfies its confirmation.
const bypassOpen = await openUrl(arbitrarySessionId, `http://127.0.0.1:${address.port}`);
const bypassSave = bypassOpen.observation?.elements.find((element) => element.name === "Save Customer");
const destructiveLink = bypassOpen.observation?.elements.find((element) => element.name === "Delete account");
assert.ok(bypassSave && destructiveLink);
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: destructiveLink.id })).status, "ACTION_NEEDS_CONFIRMATION");
await performAction(arbitrarySessionId, { action: "cancel_pending" });
assert.equal((await performAction(arbitrarySessionId, { action: "click", elementId: bypassSave.id, confirmation: "do it always don't ask me" })).status, "ACTION_NEEDS_CONFIRMATION");
assert.equal((await performAction(arbitrarySessionId, { action: "confirm_pending", confirmation: "do it always don't ask me" })).status, "CONFIRMATION_REJECTED");

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
assert.match(toolSource, /confirmBrowserAction\(context\.conversationId, context\.latestUserMessage\)/);

const controllerSource = readFileSync("app/api/kino/route.ts", "utf8");
assert.doesNotMatch(controllerSource, /playwright|browser-manager/);
assert.doesNotMatch(controllerSource, /loginBrowser/);
assert.match(controllerSource, /MAX_BROWSER_STEPS/);
assert.match(controllerSource, /duplicateActions/);
assert.match(controllerSource, /actionHistory/);
assert.match(controllerSource, /toolCalls\.slice\(0, 1\)/);
assert.match(controllerSource, /withTransientAiTransportRetry/);
assert.match(controllerSource, /KINO_AI_TRANSPORT_RETRY/);
assert.match(controllerSource, /KINO_API_ERROR/);
assert.match(controllerSource, /KINO_OLLAMA_HTTP_ERROR/);
assert.match(controllerSource, /OllamaHttpError/);
assert.match(controllerSource, /ModelTranscriptInvalidError/);
assert.match(controllerSource, /buildQwenAgentTranscript/);
assert.doesNotMatch(controllerSource, /agentMessages\.push\(\{\s*role: "system"/);
assert.doesNotMatch(controllerSource, /console\.(?:log|warn|error)\([^\n]*(?:messages|serializedRequest|OLLAMA_API_KEY)/);
const modelRetrySection = controllerSource.slice(
  controllerSource.indexOf("const assistant = await withTransientAiTransportRetry"),
  controllerSource.indexOf("const toolCalls = assistant.tool_calls"),
);
assert.doesNotMatch(modelRetrySection, /executeKinoTool|web_action|web_open_url/);
const toolsIndexSource = readFileSync("lib/kino/tools/index.ts", "utf8");
assert.doesNotMatch(toolsIndexSource, /playwright|browser-manager/);

const loginRouteSource = readFileSync("app/api/kino/browser-login/route.ts", "utf8");
assert.doesNotMatch(loginRouteSource, /console\.(?:log|info|error).*username|console\.(?:log|info|error).*password/);
assert.match(loginRouteSource, /loginBrowser/);
const workerSource = readFileSync("browser-worker/sessions.ts", "utf8");
assert.match(workerSource, /username = ""/);
assert.match(workerSource, /password = ""/);
assert.match(workerSource, /inspectRegisteredElement/);
assert.match(workerSource, /pageSignature/);
assert.match(workerSource, /effectVerified/);
assert.doesNotMatch(workerSource, /role: "button", name: pending/);
assert.match(workerSource, /pendingElementStillMatches/);
assert.match(workerSource, /ACTION_UNVERIFIED/);
assert.match(workerSource, /READ_NAVIGATION/);
assert.match(workerSource, /STALE_ELEMENT/);
assert.match(workerSource, /NAVIGATION_UNVERIFIED/);
assert.match(workerSource, /DOWNLOAD_REQUIRES_HANDLING/);
assert.match(workerSource, /animations: "disabled"/);
assert.match(workerSource, /caret: "hide"/);
assert.match(workerSource, /SENSITIVE_SCREENSHOT_SELECTOR/);
for (const sensitiveAttribute of [
  "password", "current-password", "new-password", "one-time-code", "cc-number",
  "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year",
]) {
  assert.match(workerSource, new RegExp(sensitiveAttribute), sensitiveAttribute);
}
const screenshotSection = workerSource.slice(
  workerSource.indexOf("export async function screenshotSession"),
  workerSource.indexOf("export async function openUrl"),
);
assert.doesNotMatch(screenshotSection, /inputValue|evaluate|textContent|innerText/);
const workerServerSource = readFileSync("browser-worker/server.ts", "utf8");
assert.match(workerServerSource, /timingSafeEqual/);
assert.match(workerServerSource, /service: "kino-browser-worker"/);
assert.doesNotMatch(workerServerSource, /activeSessions/);
assert.doesNotMatch(workerServerSource, /console\.(?:log|info|error).*authorization/i);
assert.match(workerServerSource, /"\/browser\/screenshot"/);
assert.match(workerServerSource, /"Content-Type": "image\/jpeg"/);
const workerClientSource = readFileSync("lib/kino/browser-worker/client.ts", "utf8");
assert.doesNotMatch(workerClientSource, /local-unconfigured-worker/);
assert.doesNotMatch(workerClientSource, /NEXT_PUBLIC_/);
const browserViewRouteSource = readFileSync("app/api/kino/browser-view/route.ts", "utf8");
assert.match(browserViewRouteSource, /sameOrigin/);
assert.match(browserViewRouteSource, /captureBrowserScreenshot/);
assert.doesNotMatch(browserViewRouteSource, /KINO_BROWSER_WORKER_(?:TOKEN|URL)|playwright/i);
const browserStateSection = workerSource.slice(
  workerSource.indexOf("export async function browserViewState"),
  workerSource.indexOf("const SENSITIVE_SCREENSHOT_SELECTOR"),
);
assert.doesNotMatch(browserStateSection, /createSession|observePage|page\.(?:goto|click|fill|reload)/);
const pageSource = readFileSync("app/page.tsx", "utf8");
assert.match(pageSource, /URL\.createObjectURL/);
assert.match(pageSource, /URL\.revokeObjectURL/);
assert.match(pageSource, /visibilityState/);
assert.match(pageSource, /screenshotRequestRef\.current/);
assert.match(pageSource, /controller\?\.abort\(\)/);
assert.match(pageSource, /clearTimeout\(timer\)/);
assert.doesNotMatch(pageSource, /playwright|KINO_BROWSER_WORKER_(?:TOKEN|URL)/i);
const pollingSection = pageSource.slice(
  pageSource.indexOf("const refreshBrowserState"),
  pageSource.indexOf("async function sendMessage"),
);
assert.doesNotMatch(pollingSection, /ollama|fetch\("\/api\/kino"\)/i);
assert.match(controllerSource, /Ordinary page navigation is a read action/);
assert.match(controllerSource, /STALE_ELEMENT/);
assert.match(controllerSource, /web_observe/);
assert.equal(shouldContinueSafeBrowserNarration("Open the Forza page", "I've returned to the main page. Now I can see the link. Let me click on it.", 0), true);
assert.equal(shouldContinueSafeBrowserNarration("Open the Forza page", "The requested page is now open.", 0), false);
assert.equal(shouldContinueSafeBrowserNarration("Open the Forza page", "Let me click on it.", 2), false);
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
