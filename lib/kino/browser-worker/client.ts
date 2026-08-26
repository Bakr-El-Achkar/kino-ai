import { createHmac } from "node:crypto";

import type {
  AuthenticationResult,
  BrowserActionKind,
  BrowserActionResult,
  BrowserOpenResult,
  BrowserScreenshot,
  BrowserSessionState,
  BrowserViewState,
  WorkerErrorResult,
} from "./types";

const REQUEST_TIMEOUT_MS = 45_000;
const SCREENSHOT_TIMEOUT_MS = 15_000;

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

export function getBrowserViewState(conversationId: string) {
  return requestWorker<BrowserViewState>("/browser/state", conversationId);
}

export async function captureBrowserScreenshot(
  conversationId: string,
): Promise<BrowserScreenshot | WorkerErrorResult> {
  const config = configuration();
  if (!config) return workerUnavailable("The browser worker is not configured.");
  const sessionId = browserSessionId(conversationId);
  if (!sessionId) return workerUnavailable("The browser worker is not configured.");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SCREENSHOT_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.baseUrl}/browser/screenshot`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ sessionId }),
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      const result = await response.json().catch(() => null) as WorkerErrorResult | null;
      return result?.status ? result : workerUnavailable();
    }
    if (response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "image/jpeg") {
      return workerUnavailable("The browser worker returned an invalid screenshot response.");
    }
    const bytes = await response.arrayBuffer();
    const signature = new Uint8Array(bytes, 0, Math.min(2, bytes.byteLength));
    if (bytes.byteLength < 4 || signature[0] !== 0xff || signature[1] !== 0xd8) {
      return workerUnavailable("The browser worker returned an invalid screenshot response.");
    }
    return { success: true, status: "SCREENSHOT_READY", contentType: "image/jpeg", bytes };
  } catch {
    return workerUnavailable();
  } finally {
    clearTimeout(timeout);
  }
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
