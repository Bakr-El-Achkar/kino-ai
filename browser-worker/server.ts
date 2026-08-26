import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { browserViewState, cleanupExpiredSessions, closeSession, loginSession, observeSession, openUrl, performAction, screenshotSession, shutdownWorker } from "./sessions.ts";

const host = process.env.KINO_BROWSER_WORKER_HOST?.trim() || "127.0.0.1";
const port = Number.parseInt(process.env.KINO_BROWSER_WORKER_PORT ?? "8787", 10);
const token = process.env.KINO_BROWSER_WORKER_TOKEN?.trim();
const MAX_BODY_BYTES = 16_384;

if (!token || token.length < 16) {
  throw new Error("KINO_BROWSER_WORKER_TOKEN must contain at least 16 characters.");
}
const expectedAuthorizationDigest = createHash("sha256").update(`Bearer ${token}`).digest();

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function jpeg(response: ServerResponse, bytes: Buffer) {
  response.writeHead(200, {
    "Content-Type": "image/jpeg",
    "Content-Length": bytes.byteLength,
    "Cache-Control": "no-store, private",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(bytes);
}

function authorized(request: IncomingMessage) {
  const actual = request.headers.authorization;
  if (typeof actual !== "string") return false;
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(actualDigest, expectedAuthorizationDigest);
}

async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("BODY_TOO_LARGE");
    chunks.push(buffer);
  }
  const combined = Buffer.concat(chunks);
  let parsed: unknown;
  try {
    parsed = JSON.parse(combined.toString("utf8")) as unknown;
  } finally {
    combined.fill(0);
    chunks.forEach((chunk) => chunk.fill(0));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("INVALID_BODY");
  return parsed as Record<string, unknown>;
}

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    json(response, 200, { status: "ok", service: "kino-browser-worker" });
    return;
  }
  if (request.method !== "POST" || !request.url?.startsWith("/browser/")) {
    json(response, 404, { success: false, status: "INVALID_REQUEST", message: "Route not found." });
    return;
  }
  if (!authorized(request)) {
    json(response, 401, { success: false, status: "INVALID_REQUEST", message: "Worker authentication failed." });
    return;
  }
  try {
    const payload = await body(request);
    const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    let result;
    if (request.url === "/browser/open") {
      result = await openUrl(sessionId, typeof payload.url === "string" ? payload.url : "");
    } else if (request.url === "/browser/observe") {
      result = await observeSession(sessionId);
    } else if (request.url === "/browser/state") {
      result = await browserViewState(sessionId);
    } else if (request.url === "/browser/screenshot") {
      const screenshot = await screenshotSession(sessionId);
      if ("bytes" in screenshot) {
        jpeg(response, screenshot.bytes);
        return;
      }
      result = screenshot;
    } else if (request.url === "/browser/action") {
      result = await performAction(sessionId, {
        action: typeof payload.action === "string" ? payload.action : "",
        elementId: typeof payload.elementId === "string" ? payload.elementId : undefined,
        value: ["string", "number", "boolean"].includes(typeof payload.value) ? payload.value as string | number | boolean : undefined,
        direction: payload.direction === "up" ? "up" : payload.direction === "down" ? "down" : undefined,
        confirmation: typeof payload.confirmation === "string" ? payload.confirmation : undefined,
      });
    } else if (request.url === "/browser/login") {
      let username = typeof payload.username === "string" ? payload.username : "";
      let password = typeof payload.password === "string" ? payload.password : "";
      delete payload.username;
      delete payload.password;
      try {
        if (!username || !password || username.length > 1_000 || password.length > 4_096) {
          result = { success: false, status: "INVALID_REQUEST", message: "Secure login values are missing or invalid.", authenticated: false };
        } else {
          result = await loginSession(sessionId, username, password);
        }
      } finally {
        username = "";
        password = "";
      }
    } else if (request.url === "/browser/close") {
      result = await closeSession(sessionId);
    } else {
      json(response, 404, { success: false, status: "INVALID_REQUEST", message: "Route not found." });
      return;
    }
    json(response, result.success ? 200 : 409, result);
  } catch {
    json(response, 400, { success: false, status: "INVALID_REQUEST", message: "The worker request was invalid." });
  }
});

const cleanupTimer = setInterval(() => void cleanupExpiredSessions(), 60_000);
cleanupTimer.unref();

server.listen(port, host, () => {
  console.info(`KINO browser worker listening on http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void shutdownWorker().finally(() => process.exit(0));
    });
  });
}
