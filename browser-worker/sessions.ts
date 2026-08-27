import { randomUUID } from "node:crypto";

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";

import { buildCriticalConfirmationPhrase, parseActionConfirmation } from "../lib/kino/web-agent/action-confirmation.ts";
import { classifyActionRisk, explicitExternalEffectRisk } from "../lib/kino/web-agent/action-risk.ts";
import { isSensitiveFormField } from "../lib/kino/web-agent/form-matcher.ts";
import type { BrowserActionKind, BrowserActionResult, BrowserObservation, BrowserOpenResult, BrowserSessionState, BrowserViewState, PendingBrowserAction } from "../lib/kino/browser-worker/types.ts";
import { inspectRegisteredElement, observePage, type ElementRegistry, type RegisteredElement } from "./observer.ts";
import { developmentPrivateNetworkEscapeEnabled, routedRequestProtocolPolicy, validatePublicUrl } from "./url-security.ts";

const configuredSessionTtl = Number.parseInt(process.env.KINO_BROWSER_SESSION_TTL_MS ?? "1800000", 10);
const SESSION_TTL_MS = Number.isSafeInteger(configuredSessionTtl) && configuredSessionTtl >= 60_000 ? configuredSessionTtl : 1_800_000;
const configuredMaxSessions = Number.parseInt(process.env.KINO_BROWSER_MAX_SESSIONS ?? "20", 10);
const MAX_SESSIONS = Number.isSafeInteger(configuredMaxSessions) && configuredMaxSessions > 0 ? configuredMaxSessions : 20;
const PENDING_TTL_MS = 5 * 60_000;
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

type InternalPendingAction = {
  public: PendingBrowserAction;
  element: RegisteredElement;
  identity: PendingElementIdentity;
  value?: string | number | boolean;
};

type PendingElementIdentity = {
  pageUrl: string;
  role: RegisteredElement["semantic"]["role"];
  name: string;
  tagName: string;
  buttonType?: string;
  inputType?: string;
  href?: string;
  checked?: boolean;
  disabled: boolean;
  fingerprint: string;
  observationGeneration: number;
  documentGeneration: number;
};

type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  registry: ElementRegistry;
  lastObservation?: BrowserObservation;
  pending?: InternalPendingAction;
  lastActive: number;
  navigationBlocked?: string;
  learnedNavigation: Set<string>;
  validatedHosts: Map<string, { allowed: boolean; message: string; expiresAt: number }>;
  nextElementOrdinal: number;
  observationGeneration: number;
  documentGeneration: number;
  retiredElementIds: Set<string>;
};

const sessions = new Map<string, BrowserSession>();
let sharedBrowser: Promise<Browser> | null = null;

function safeSessionRef(sessionId: string) {
  return sessionId.slice(0, 12);
}

function audit(sessionId: string, action: string, status: string, details: Record<string, unknown> = {}) {
  console.info("KINO_BROWSER_AUDIT", {
    timestamp: new Date().toISOString(),
    sessionRef: safeSessionRef(sessionId),
    action,
    status,
    ...details,
  });
}

function failure(status: BrowserActionResult["status"], message: string): BrowserActionResult {
  return { success: false, status, message };
}

function validSessionId(sessionId: string) {
  return SESSION_ID_PATTERN.test(sessionId);
}

async function browser() {
  if (sharedBrowser && !(await sharedBrowser).isConnected()) sharedBrowser = null;
  sharedBrowser ??= chromium.launch({ headless: process.env.KINO_BROWSER_HEADLESS !== "false" });
  return sharedBrowser;
}

async function installNavigationGuard(session: BrowserSession) {
  await session.context.route("**/*", async (route) => {
    const request = route.request();
    let requestUrl: URL;
    try {
      requestUrl = new URL(request.url());
    } catch {
      await route.abort("blockedbyclient");
      return;
    }
    const topLevelNavigation = request.isNavigationRequest() && request.frame() === session.page.mainFrame();
    const protocolPolicy = routedRequestProtocolPolicy(request.url(), topLevelNavigation);
    if (!protocolPolicy.allowed) {
      if (topLevelNavigation) session.navigationBlocked = protocolPolicy.message;
      await route.abort("blockedbyclient");
      return;
    }
    if (!protocolPolicy.validateNetworkTarget) {
      await route.continue();
      return;
    }
    const cacheKey = `${requestUrl.protocol}//${requestUrl.host}`;
    const cached = request.isNavigationRequest() ? undefined : session.validatedHosts.get(cacheKey);
    let allowed = cached?.allowed;
    let message = cached?.message ?? "The request target is blocked.";
    if (!cached || cached.expiresAt <= Date.now()) {
      const validation = await validatePublicUrl(request.url(), {
        allowPrivate: developmentPrivateNetworkEscapeEnabled(),
      });
      allowed = validation.allowed;
      message = validation.allowed ? "" : validation.message;
      session.validatedHosts.set(cacheKey, { allowed, message, expiresAt: Date.now() + 60_000 });
    }
    if (!allowed) {
      if (topLevelNavigation) {
        session.navigationBlocked = message;
      }
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

async function createSession(sessionId: string) {
  const activeBrowser = await browser();
  const context = await activeBrowser.newContext();
  const page = await context.newPage();
  const session: BrowserSession = {
    browser: activeBrowser,
    context,
    page,
    registry: new Map(),
    lastActive: Date.now(),
    learnedNavigation: new Set(),
    validatedHosts: new Map(),
    nextElementOrdinal: 1,
    observationGeneration: 0,
    documentGeneration: 0,
    retiredElementIds: new Set(),
  };
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    session.documentGeneration += 1;
    for (const [elementId, entry] of session.registry) {
      session.retiredElementIds.add(elementId);
      void entry.handle.dispose().catch(() => {});
    }
    session.registry.clear();
  });
  await installNavigationGuard(session);
  sessions.set(sessionId, session);
  return session;
}

function activeSession(sessionId: string) {
  if (!validSessionId(sessionId)) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.lastActive >= SESSION_TTL_MS) {
    void closeSession(sessionId);
    return null;
  }
  session.lastActive = Date.now();
  return session;
}

async function observation(session: BrowserSession) {
  for (const elementId of session.registry.keys()) session.retiredElementIds.add(elementId);
  while (session.retiredElementIds.size > 5_000) {
    const oldest = session.retiredElementIds.values().next().value as string | undefined;
    if (!oldest) break;
    session.retiredElementIds.delete(oldest);
  }
  session.observationGeneration += 1;
  const result = await observePage(session.page, session.registry, {
    allocateElementId: () => `e${session.nextElementOrdinal++}`,
    observationGeneration: session.observationGeneration,
    documentGeneration: session.documentGeneration,
  });
  result.learnedNavigation.forEach((name) => session.learnedNavigation.add(name));
  result.learnedNavigation = Array.from(session.learnedNavigation).slice(-60);
  session.lastObservation = result;
  return result;
}

function safeViewUrl(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

export async function browserViewState(sessionId: string): Promise<BrowserViewState> {
  const session = activeSession(sessionId);
  if (!session) {
    return { success: false, status: "SESSION_EXPIRED", message: "The browser session expired or does not exist.", active: false };
  }
  try {
    return {
      success: true,
      status: session.lastObservation?.status ?? "OBSERVED",
      message: "The active browser page state is available.",
      active: true,
      url: safeViewUrl(session.page.url()),
      title: (await session.page.title()).slice(0, 300),
      pageStatus: session.lastObservation?.status,
      authentication: session.lastObservation?.authentication,
      updatedAt: new Date().toISOString(),
    };
  } catch {
    return { success: false, status: "SESSION_EXPIRED", message: "The browser session expired or does not exist.", active: false };
  }
}

const SENSITIVE_SCREENSHOT_SELECTOR = [
  'input[type="password"]',
  'input[autocomplete~="current-password" i]',
  'input[autocomplete~="new-password" i]',
  'input[autocomplete~="one-time-code" i]',
  'input[autocomplete~="cc-number" i]',
  'input[autocomplete~="cc-csc" i]',
  'input[autocomplete~="cc-exp" i]',
  'input[autocomplete~="cc-exp-month" i]',
  'input[autocomplete~="cc-exp-year" i]',
  'input[name*="password" i]',
  'input[id*="password" i]',
  'input[name*="security-code" i]',
  'input[id*="security-code" i]',
].join(",");

export async function screenshotSession(sessionId: string) {
  const session = activeSession(sessionId);
  if (!session) return failure("SESSION_EXPIRED", "The browser session expired or does not exist.");
  try {
    const mask = [session.page.locator(SENSITIVE_SCREENSHOT_SELECTOR)];
    for (const entry of session.registry.values()) {
      if (entry.semantic.inputType === "password" || isSensitiveFormField({ name: entry.semantic.name })) {
        mask.push(entry.locator);
      }
    }
    const bytes = await session.page.screenshot({
      type: "jpeg",
      quality: 76,
      fullPage: false,
      animations: "disabled",
      caret: "hide",
      mask,
      maskColor: "#07141a",
      timeout: 12_000,
    });
    return { success: true as const, status: "SCREENSHOT_READY" as const, message: "The current browser viewport was captured.", bytes };
  } catch {
    return failure("ACTION_FAILED", "The browser viewport could not be captured.");
  }
}

export async function openUrl(sessionId: string, value: string): Promise<BrowserOpenResult> {
  if (!validSessionId(sessionId)) return { success: false, status: "INVALID_REQUEST", message: "The browser session identity is invalid." };
  const validation = await validatePublicUrl(value, { allowPrivate: developmentPrivateNetworkEscapeEnabled() });
  if (!validation.allowed) return { success: false, status: validation.status, message: validation.message };
  if (!activeSession(sessionId) && sessions.size >= MAX_SESSIONS) {
    await cleanupExpiredSessions();
    if (sessions.size >= MAX_SESSIONS) return { success: false, status: "ACTION_FAILED", message: "The browser worker has reached its active-session limit." };
  }
  const session = activeSession(sessionId) ?? await createSession(sessionId);
  session.navigationBlocked = undefined;
  session.pending = undefined;
  try {
    await session.page.goto(validation.url.href, { waitUntil: "domcontentloaded", timeout: 40_000 });
    await session.page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
    if (session.navigationBlocked) return { success: false, status: "URL_BLOCKED", message: session.navigationBlocked };
    const observed = await observation(session);
    audit(sessionId, "open", observed.status, { origin: new URL(observed.url).origin });
    return {
      success: true,
      status: observed.status === "OBSERVED" ? "OPENED" : observed.status,
      message: observed.status === "AUTH_REQUIRED" ? "Authentication is required." : "The public website was opened and observed.",
      observation: observed,
    };
  } catch {
    if (session.navigationBlocked) return { success: false, status: "URL_BLOCKED", message: session.navigationBlocked };
    return { success: false, status: "ACTION_FAILED", message: "The website could not be opened." };
  }
}

export async function observeSession(sessionId: string): Promise<BrowserSessionState> {
  const session = activeSession(sessionId);
  if (!session) return { success: false, status: "SESSION_EXPIRED", message: "The browser session expired or does not exist." };
  try {
    const observed = await observation(session);
    return { success: true, status: observed.status, message: "The current page was observed.", observation: observed, pendingAction: session.pending?.public };
  } catch {
    return { success: false, status: "ACTION_FAILED", message: "The current page could not be observed." };
  }
}

function actionDestination(element: RegisteredElement) {
  if (element.semantic.role !== "link" || !element.trustedHref) return "none" as const;
  const current = new URL(element.pageUrl);
  const target = new URL(element.trustedHref);
  return current.href === target.href ? "same-page" as const : current.origin === target.origin ? "same-origin" as const : "external" as const;
}

type ActionClassification = {
  risk: "read" | "write" | "critical";
  capability: "READ_NAVIGATION" | "READ_INTERACTION" | "DOWNLOAD" | "EXTERNAL_EFFECT";
  reason: string;
};

const DOWNLOAD_FILE_EXTENSION = /\.(?:zip|rar|7z|tar|gz|bz2|xz|exe|msi|dmg|pkg|deb|rpm|apk|iso|csv|xlsx?|docx?|pptx?)(?:$|[?#])/i;

function downloadLike(element: RegisteredElement) {
  return element.download ||
    /\b(?:download|export|save (?:file|archive)|installer)\b/i.test(element.semantic.name) ||
    Boolean(element.trustedHref && DOWNLOAD_FILE_EXTENSION.test(element.trustedHref));
}

function classifyElementAction(element: RegisteredElement, action: BrowserActionKind): ActionClassification {
  if (["fill", "select", "back", "reload", "scroll"].includes(action)) {
    return { risk: "read", capability: "READ_INTERACTION", reason: "The action does not commit external state." };
  }
  if (["check", "uncheck"].includes(action)) {
    return { risk: "write", capability: "EXTERNAL_EFFECT", reason: "Changing this control may modify application state." };
  }
  if (element.semantic.role === "link") {
    if (downloadLike(element)) return { risk: "read", capability: "DOWNLOAD", reason: "Downloads require explicit handling that is not enabled." };
    const explicitEffect = explicitExternalEffectRisk(element.semantic.name);
    if (explicitEffect) {
      return {
        risk: explicitEffect,
        capability: "EXTERNAL_EFFECT",
        reason: explicitEffect === "critical"
          ? "The link describes a destructive, security-sensitive, or financial action."
          : "The link explicitly describes an external state change.",
      };
    }
    return { risk: "read", capability: "READ_NAVIGATION", reason: "A normal HTTP(S) link is read-only navigation." };
  }
  const classified = classifyActionRisk({
    name: element.semantic.name,
    role: ["button", "link", "tab", "checkbox", "radio", "switch"].includes(element.semantic.role)
      ? element.semantic.role as "button" | "link" | "tab" | "checkbox" | "radio" | "switch"
      : "button",
    destination: actionDestination(element),
  });
  if (element.buttonType !== "submit" && /^(?:add|new|create|edit)\b/i.test(element.semantic.name) && classified.risk === "write") {
    return { risk: "read", capability: "READ_INTERACTION", reason: "The non-submit control appears to open an editing interface." };
  }
  return { ...classified, capability: classified.risk === "read" ? "READ_INTERACTION" : "EXTERNAL_EFFECT" };
}

async function pageSignature(page: Page) {
  return `${page.url()}\n${await page.title()}\n${(await page.locator("body").innerText().catch(() => "")).slice(0, 4_000)}`;
}

function pendingIdentity(element: RegisteredElement): PendingElementIdentity {
  return {
    pageUrl: element.pageUrl,
    role: element.semantic.role,
    name: element.semantic.name,
    tagName: element.tagName,
    buttonType: element.buttonType,
    inputType: element.semantic.inputType,
    href: element.semantic.href,
    checked: element.semantic.checked,
    disabled: element.semantic.disabled,
    fingerprint: element.fingerprint,
    observationGeneration: element.observationGeneration,
    documentGeneration: element.documentGeneration,
  };
}

async function elementStillMatches(session: BrowserSession, element: RegisteredElement) {
  if (session.page.url() !== element.pageUrl || element.documentGeneration !== session.documentGeneration) return false;
  if (!(await element.handle.isVisible().catch(() => false)) || !(await element.handle.isEnabled().catch(() => false))) return false;
  const live = await inspectRegisteredElement(element, session.page.url());
  return Boolean(live && !live.disabled && live.fingerprint === element.fingerprint);
}

async function pendingElementStillMatches(pending: InternalPendingAction, session: BrowserSession) {
  return pending.identity.fingerprint === pending.element.fingerprint &&
    pending.identity.observationGeneration === pending.element.observationGeneration &&
    pending.identity.documentGeneration === session.documentGeneration &&
    await elementStillMatches(session, pending.element);
}

const SUCCESS_EVIDENCE = /\b(?:success|saved|created|updated|deleted|sent|completed|submitted|refunded|done)\b/i;

async function statusTexts(page: Page) {
  return page.locator('[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]')
    .allInnerTexts().then((values) => values.map((value) => value.trim().replace(/\s+/g, " ")).filter(Boolean)).catch(() => [] as string[]);
}

async function executeElementAction(
  session: BrowserSession,
  action: BrowserActionKind,
  element: RegisteredElement,
  value?: string | number | boolean,
  committedRisk: "write" | "critical" | null = null,
  capability: ActionClassification["capability"] = "READ_INTERACTION",
) {
  const handle = element.handle;
  if (!(await elementStillMatches(session, element)) || element.semantic.disabled) return failure("STALE_ELEMENT", "The semantic element changed or expired; observe the page again before acting.");
  if (capability === "DOWNLOAD") return failure("DOWNLOAD_REQUIRES_HANDLING", "KINO did not activate this download because explicit download handling is not enabled.");
  if (capability === "READ_NAVIGATION") {
    if (!element.trustedHref) return failure("URL_BLOCKED", "Only HTTP(S) link navigation is allowed.");
    const validation = await validatePublicUrl(element.trustedHref, { allowPrivate: developmentPrivateNetworkEscapeEnabled() });
    if (!validation.allowed) return failure(validation.status, validation.message);
  }
  const before = await pageSignature(session.page);
  const beforeUrl = session.page.url();
  const beforeDocumentGeneration = session.documentGeneration;
  const beforeName = (await inspectRegisteredElement(element, beforeUrl))?.name ?? element.semantic.name;
  const beforeStatusTexts = new Set(await statusTexts(session.page));
  const form = element.locator.locator("xpath=ancestor::form[1]");
  const formWasVisible = await form.isVisible().catch(() => false);
  const possibleDownload = capability === "READ_NAVIGATION"
    ? session.page.waitForEvent("download", { timeout: 1_500 }).catch(() => null)
    : Promise.resolve(null);
  session.navigationBlocked = undefined;
  if (action === "click") await handle.click({ timeout: 10_000 });
  else if (action === "fill") {
    if (element.semantic.inputType === "password" || isSensitiveFormField({ name: element.semantic.name })) {
      return failure("ELEMENT_NOT_ACTIONABLE", "Sensitive fields can only be filled through secure login.");
    }
    if (typeof value !== "string" && typeof value !== "number") return failure("INVALID_REQUEST", "A simple ordinary field value is required.");
    await handle.fill(String(value));
    if ((await handle.inputValue()) !== String(value)) return failure("ACTION_FAILED", "The ordinary field value could not be verified.");
  } else if (action === "select") {
    if (typeof value !== "string") return failure("INVALID_REQUEST", "A discovered native option is required.");
    if (!element.semantic.options?.includes(value)) return failure("INVALID_REQUEST", "The requested value is not one of the discovered native options.");
    await handle.selectOption({ label: value });
  } else if (action === "check") await handle.check();
  else if (action === "uncheck") await handle.uncheck();
  await session.page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
  await session.page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => {});
  if (session.navigationBlocked) return failure("URL_BLOCKED", session.navigationBlocked);
  const download = await possibleDownload;
  if (download) {
    await download.cancel().catch(() => {});
    const observed = await observation(session).catch(() => undefined);
    return {
      success: false,
      status: "DOWNLOAD_REQUIRES_HANDLING" as const,
      message: "The server responded with a download. KINO cancelled it because explicit download handling is not enabled.",
      action,
      elementId: element.semantic.id,
      effectVerified: false,
      observation: observed,
    };
  }
  if (capability === "READ_NAVIGATION") {
    const afterUrl = session.page.url();
    const exactExpectedDestination = afterUrl === element.trustedHref;
    const actionLinkedNavigation = afterUrl !== beforeUrl && session.documentGeneration > beforeDocumentGeneration;
    const verified = exactExpectedDestination || actionLinkedNavigation;
    const observed = await observation(session);
    return {
      success: verified,
      status: verified ? "ACTION_COMPLETED" as const : "NAVIGATION_UNVERIFIED" as const,
      message: verified
        ? "The read-only navigation completed and its destination was verified."
        : "The link was activated, but the expected navigation could not be verified.",
      action,
      elementId: element.semantic.id,
      effectVerified: verified,
      observation: observed,
    };
  }
  const controlVerified = action === "check"
    ? await handle.isChecked().catch(() => false)
    : action === "uncheck"
      ? !(await handle.isChecked().catch(() => true))
      : action === "select"
        ? await handle.evaluate((node) => (node as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() ?? "").catch(() => "") === String(value)
        : action === "fill";
  const targetVisible = await handle.isVisible().catch(() => false);
  const targetEnabled = targetVisible && await handle.isEnabled().catch(() => false);
  const afterName = targetVisible ? (await inspectRegisteredElement(element, session.page.url()))?.name ?? "" : "";
  const newPositiveStatus = (await statusTexts(session.page)).some((text) => !beforeStatusTexts.has(text) && SUCCESS_EVIDENCE.test(text));
  const stronglyVerified = controlVerified ||
    session.page.url() !== beforeUrl ||
    !targetVisible ||
    !targetEnabled ||
    (formWasVisible && !(await form.isVisible({ timeout: 500 }).catch(() => false))) ||
    (afterName !== beforeName && SUCCESS_EVIDENCE.test(afterName)) ||
    newPositiveStatus;
  const observed = await observation(session);
  const after = committedRisk ? "" : await pageSignature(session.page);
  const verified = committedRisk ? stronglyVerified : controlVerified || before !== after;
  const status = verified ? "ACTION_COMPLETED" as const : committedRisk ? "ACTION_UNVERIFIED" as const : "ACTION_FAILED" as const;
  return {
    success: verified || Boolean(committedRisk),
    status,
    message: verified
      ? "The browser action completed and its effect was verified."
      : committedRisk
        ? "The control was activated, but completion could not be strongly verified."
        : "The control was activated, but no resulting state change could be verified.",
    action,
    elementId: element.semantic.id,
    effectVerified: verified,
    observation: observed,
  };
}

function publicPending(element: RegisteredElement, action: BrowserActionKind, risk: "write" | "critical"): PendingBrowserAction {
  const requiredConfirmationPhrase = risk === "critical" ? buildCriticalConfirmationPhrase(element.semantic.name) : undefined;
  return {
    id: randomUUID(),
    elementId: element.semantic.id,
    action,
    summary: `${action} ${element.semantic.role} “${element.semantic.name}”`,
    risk,
    requiredConfirmationPhrase,
    expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
  };
}

export async function performAction(
  sessionId: string,
  request: { action: string; elementId?: string; value?: string | number | boolean; direction?: "up" | "down"; confirmation?: string },
): Promise<BrowserActionResult> {
  const session = activeSession(sessionId);
  if (!session) return failure("SESSION_EXPIRED", "The browser session expired or does not exist.");
  if (request.action === "cancel_pending") {
    if (!session.pending) return failure("CONFIRMATION_REJECTED", "There is no pending browser action to cancel.");
    session.pending = undefined;
    audit(sessionId, "cancel", "ACTION_CANCELLED");
    return { success: true, status: "ACTION_CANCELLED", message: "The pending browser action was cancelled." };
  }
  if (request.action === "confirm_pending") {
    const pending = session.pending;
    if (!pending || Date.parse(pending.public.expiresAt) <= Date.now()) {
      session.pending = undefined;
      return failure("CONFIRMATION_REJECTED", "The exact pending browser action is missing or expired.");
    }
    const parsed = parseActionConfirmation({
      message: request.confirmation ?? "",
      risk: pending.public.risk,
      requiredPhrase: pending.public.requiredConfirmationPhrase,
    });
    if (!parsed.explicit) return failure("CONFIRMATION_REJECTED", parsed.reason === "STRONG_CONFIRMATION_REQUIRED" ? `Critical confirmation requires: ${pending.public.requiredConfirmationPhrase}` : "The latest message did not explicitly confirm the exact pending action.");
    if (!(await pendingElementStillMatches(pending, session))) {
      session.pending = undefined;
      return failure("STALE_ELEMENT", "The page or pending control changed before confirmation; observe the page again.");
    }
    session.pending = undefined;
    audit(sessionId, "confirm", "ACTION_EXECUTION_STARTED", { risk: pending.public.risk, semanticElement: pending.public.elementId });
    const result = await executeElementAction(session, pending.public.action, pending.element, pending.value, pending.public.risk, "EXTERNAL_EFFECT");
    audit(sessionId, "confirm", result.status, { risk: pending.public.risk, verified: result.effectVerified === true });
    return result;
  }

  const action = request.action as BrowserActionKind;
  if (["back", "reload", "scroll"].includes(action)) {
    session.navigationBlocked = undefined;
    if (action === "back") await session.page.goBack({ waitUntil: "domcontentloaded" });
    else if (action === "reload") await session.page.reload({ waitUntil: "domcontentloaded" });
    else await session.page.mouse.wheel(0, request.direction === "up" ? -700 : 700);
    const observed = await observation(session);
    return { success: true, status: "ACTION_COMPLETED", message: "The browser navigation action completed.", action, effectVerified: true, observation: observed };
  }
  if (!request.elementId || !/^e\d+$/.test(request.elementId)) return failure("INVALID_REQUEST", "A semantic element ID from the latest observation is required.");
  const element = session.registry.get(request.elementId);
  if (!element) {
    return session.retiredElementIds.has(request.elementId)
      ? failure("STALE_ELEMENT", "That semantic element belongs to an older page observation; observe the page again.")
      : failure("ELEMENT_NOT_FOUND", "The semantic element is not present in the latest observation.");
  }
  if (!(await elementStillMatches(session, element))) {
    session.retiredElementIds.add(request.elementId);
    session.registry.delete(request.elementId);
    await element.handle.dispose().catch(() => {});
    return failure("STALE_ELEMENT", "The semantic element changed or expired; observe the page again before acting.");
  }
  const classification = classifyElementAction(element, action);
  if (classification.capability === "DOWNLOAD") {
    return failure("DOWNLOAD_REQUIRES_HANDLING", "KINO did not activate this download because explicit download handling is not enabled.");
  }
  if (classification.risk !== "read") {
    const pending = publicPending(element, action, classification.risk);
    session.pending = { public: pending, element, identity: pendingIdentity(element), value: request.value };
    audit(sessionId, action, "ACTION_NEEDS_CONFIRMATION", { risk: classification.risk, semanticElement: element.semantic.id });
    return { success: true, status: "ACTION_NEEDS_CONFIRMATION", message: classification.reason, action, elementId: element.semantic.id, effectVerified: false, pendingAction: pending };
  }
  const result = await executeElementAction(session, action, element, request.value, null, classification.capability);
  audit(sessionId, action, result.status, { semanticElement: element.semantic.id, verified: result.effectVerified === true });
  return result;
}

async function clearLoginFields(fields: Locator[]) {
  await Promise.all(fields.map((field) => field.fill("", { timeout: 500 }).catch(() => {})));
}

export async function loginSession(sessionId: string, usernameValue: string, passwordValue: string) {
  const session = activeSession(sessionId);
  if (!session) return { success: false, status: "SESSION_EXPIRED" as const, message: "The browser session expired or does not exist.", authenticated: false };
  let username = usernameValue;
  let password = passwordValue;
  let credentialFields: Locator[] = [];
  try {
    const observed = await observation(session);
    if (observed.status === "CAPTCHA_REQUIRED" || observed.status === "MFA_REQUIRED") {
      return { success: false, status: observed.status, message: "Human intervention is required before login can continue.", authenticated: false };
    }
    const passwordEntry = Array.from(session.registry.values()).find((entry) => entry.semantic.inputType === "password");
    const usernameEntry = Array.from(session.registry.values()).find((entry) =>
      ["email", "text"].includes(entry.semantic.inputType ?? "") && /(?:email|user|login)/i.test(entry.semantic.name),
    ) ?? Array.from(session.registry.values()).find((entry) => ["email", "text"].includes(entry.semantic.inputType ?? ""));
    if (!passwordEntry || !usernameEntry) return { success: false, status: "AUTH_FAILED" as const, message: "The login form changed or could not be identified safely.", authenticated: false };
    credentialFields = [usernameEntry.locator, passwordEntry.locator];
    const submit = Array.from(session.registry.values()).find((entry) => entry.semantic.role === "button" && /(?:sign\s*in|log\s*in|login|continue|submit)/i.test(entry.semantic.name))
      ?? Array.from(session.registry.values()).find((entry) => entry.buttonType === "submit");
    if (!submit) return { success: false, status: "AUTH_FAILED" as const, message: "The login submit control could not be identified safely.", authenticated: false };
    const beforeUrl = session.page.url();
    await usernameEntry.locator.fill(username);
    await passwordEntry.locator.fill(password);
    await submit.locator.click({ timeout: 10_000 });
    await session.page.waitForLoadState("domcontentloaded", { timeout: 8_000 }).catch(() => {});
    await session.page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});
    const after = await observation(session);
    if (after.status === "CAPTCHA_REQUIRED" || after.status === "MFA_REQUIRED") {
      await clearLoginFields([usernameEntry.locator, passwordEntry.locator]);
      audit(sessionId, "login", after.status);
      return { success: false, status: after.status, message: "Human verification is required.", authenticated: false };
    }
    if (after.status === "AUTH_REQUIRED") {
      await clearLoginFields([usernameEntry.locator, passwordEntry.locator]);
      audit(sessionId, "login", "AUTH_FAILED");
      return { success: false, status: "AUTH_FAILED" as const, message: "Authentication did not succeed. Check the credentials or page state.", authenticated: false };
    }
    const afterText = after.visibleText.join(" ");
    const authenticationEvidence =
      (session.page.url() !== beforeUrl && !/\/(?:login|sign-in|signin)(?:\/|$)/i.test(new URL(session.page.url()).pathname)) ||
      /\b(?:log\s*out|sign\s*out|dashboard|my account|profile|welcome)\b/i.test(afterText);
    if (!authenticationEvidence) {
      audit(sessionId, "login", "AUTH_FAILED");
      return { success: false, status: "AUTH_FAILED" as const, message: "The login form disappeared, but authentication success could not be verified.", authenticated: false };
    }
    audit(sessionId, "login", "AUTH_SUCCESS", { origin: new URL(after.url).origin });
    return { success: true, status: "AUTH_SUCCESS" as const, message: "Authentication succeeded and the runtime browser session was retained.", authenticated: true };
  } catch {
    audit(sessionId, "login", "AUTH_FAILED");
    return { success: false, status: "AUTH_FAILED" as const, message: "Authentication could not be completed safely.", authenticated: false };
  } finally {
    await clearLoginFields(credentialFields);
    credentialFields = [];
    username = "";
    password = "";
  }
}

export async function closeSession(sessionId: string): Promise<BrowserSessionState> {
  const session = sessions.get(sessionId);
  if (!session) return { success: true, status: "SESSION_CLOSED", message: "The browser session was already closed." };
  sessions.delete(sessionId);
  await session.context.close().catch(() => {});
  audit(sessionId, "close", "SESSION_CLOSED");
  return { success: true, status: "SESSION_CLOSED", message: "The browser session and runtime authentication state were discarded." };
}

export async function cleanupExpiredSessions() {
  const now = Date.now();
  await Promise.all(Array.from(sessions.entries()).filter(([, session]) => now - session.lastActive >= SESSION_TTL_MS).map(([sessionId]) => closeSession(sessionId)));
}

export function activeSessionCount() {
  return sessions.size;
}

export async function shutdownBrowserForTests() {
  if (sessions.size) throw new Error("Cannot stop the worker browser while sessions are active.");
  const running = sharedBrowser;
  sharedBrowser = null;
  if (running) await (await running).close();
}

export async function shutdownWorker() {
  await Promise.all(Array.from(sessions.keys()).map((sessionId) => closeSession(sessionId)));
  await shutdownBrowserForTests();
}
