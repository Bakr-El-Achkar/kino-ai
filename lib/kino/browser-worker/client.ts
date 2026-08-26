import { createHmac } from "node:crypto";

import type {
  AuthenticationResult,
  BrowserActionKind,
  BrowserActionResult,
  BrowserOpenResult,
  BrowserSessionState,
  WorkerErrorResult,
} from "./types";

const REQUEST_TIMEOUT_MS = 45_000;

function workerUnavailable(message = "The browser worker is currently unavailable."): WorkerErrorResult {
  return { success: false, status: "WORKER_UNAVAILABLE", message };
}

function configuration() {
  const baseUrl = process.env.KINO_BROWSER_WORKER_URL?.trim().replace(/\/+$/, "");
  const token = process.env.KINO_BROWSER_WORKER_TOKEN?.trim();
  return baseUrl && token ? { baseUrl, token } : null;
}

export function browserSessionId(conversationId: string) {
  const secret = process.env.KINO_BROWSER_WORKER_TOKEN?.trim();
  if (!secret) return null;
  return createHmac("sha256", secret).update(conversationId).digest("hex");
}

async function requestWorker<T>(
  path: string,
  conversationId: string,
  body: Record<string, unknown> = {},
): Promise<T | WorkerErrorResult> {
  const config = configuration();
  if (!config) return workerUnavailable("The browser worker is not configured.");
  const sessionId = browserSessionId(conversationId);
  if (!sessionId) return workerUnavailable("The browser worker is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
        sessionId,
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    const result = (await response.json()) as T | WorkerErrorResult;
    if (!response.ok && (!result || typeof result !== "object")) {
      return workerUnavailable();
    }
    return result;
  } catch {
    return workerUnavailable();
  } finally {
    clearTimeout(timeout);
  }
}

export function openBrowserUrl(conversationId: string, url: string) {
  return requestWorker<BrowserOpenResult>("/browser/open", conversationId, { url });
}

export function observeBrowser(conversationId: string) {
  return requestWorker<BrowserSessionState>("/browser/observe", conversationId);
}

export function performBrowserAction(
  conversationId: string,
  action: BrowserActionKind,
  options: { elementId?: string; value?: string | number | boolean; direction?: "up" | "down" },
) {
  return requestWorker<BrowserActionResult>("/browser/action", conversationId, {
    action,
    ...options,
  });
}

export function confirmBrowserAction(conversationId: string, confirmation: string) {
  return requestWorker<BrowserActionResult>("/browser/action", conversationId, {
    action: "confirm_pending",
    confirmation,
  });
}

export function cancelBrowserAction(conversationId: string) {
  return requestWorker<BrowserActionResult>("/browser/action", conversationId, {
    action: "cancel_pending",
  });
}

export async function loginBrowser(
  conversationId: string,
  credentials: { username: string; password: string },
) {
  let username = credentials.username;
  let password = credentials.password;
  credentials.username = "";
  credentials.password = "";
  try {
    return await requestWorker<AuthenticationResult>("/browser/login", conversationId, { username, password });
  } finally {
    username = "";
    password = "";
  }
}

export function closeBrowser(conversationId: string) {
  return requestWorker<BrowserSessionState>("/browser/close", conversationId);
}
