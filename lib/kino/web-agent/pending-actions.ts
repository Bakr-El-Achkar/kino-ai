import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import {
  buildCriticalConfirmationPhrase,
  isExplicitCancellation,
  parseActionConfirmation,
} from "./action-confirmation.ts";
import type {
  PendingWebAction,
  PendingWebActionStatus,
  SafeActionFingerprint,
} from "./action-types";

export const PENDING_ACTION_TTL_MILLISECONDS = 5 * 60 * 1_000;
const TERMINAL_ACTION_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAX_STORED_ACTIONS = 200;
const STORE_PATH = resolve(process.cwd(), ".kino/runtime/pending-actions.json");

type PendingActionStore = {
  version: 1;
  actions: PendingWebAction[];
};

export type CreatePendingActionInput = {
  conversationId: string;
  siteId: string;
  pageUrl: string;
  requestedIntent: string;
  matchedName: string;
  role: PendingWebAction["role"];
  risk: PendingWebAction["risk"];
  now?: Date;
};

export type ScopedPendingActionResult =
  | { status: "FOUND"; action: PendingWebAction }
  | { status: "NO_ACTION_PENDING" }
  | { status: "MULTIPLE_ACTIONS_PENDING" }
  | { status: "EXPIRED_ACTION"; action: PendingWebAction };

export type PendingActionRuntimeSummary =
  | { exists: false }
  | {
      exists: true;
      siteId: string;
      matchedAction: string;
      risk: PendingWebAction["risk"];
      expiresInSeconds: number;
    };

export function conversationScopeHash(conversationId: string) {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 24);
}

function stripUrl(url: string) {
  const safeUrl = new URL(url);
  safeUrl.username = "";
  safeUrl.password = "";
  safeUrl.search = "";
  safeUrl.hash = "";
  return safeUrl.href;
}

function isPendingAction(value: unknown): value is PendingWebAction {
  if (!value || typeof value !== "object") return false;
  const action = value as Record<string, unknown>;
  return (
    typeof action.id === "string" &&
    typeof action.conversationScope === "string" &&
    typeof action.siteId === "string" &&
    typeof action.matchedName === "string" &&
    typeof action.role === "string" &&
    (action.risk === "write" || action.risk === "critical") &&
    typeof action.createdAt === "string" &&
    typeof action.expiresAt === "string" &&
    typeof action.status === "string" &&
    typeof action.fingerprint === "object" &&
    action.fingerprint !== null
  );
}

function loadActions() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<PendingActionStore>;
    return Array.isArray(parsed.actions)
      ? parsed.actions.filter(isPendingAction)
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("Pending action runtime store could not be read; using an empty safe state.");
    return [];
  }
}

function saveActions(actions: PendingWebAction[]) {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const retained = actions
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, MAX_STORED_ACTIONS);
  const temporaryPath = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, actions: retained }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, STORE_PATH);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function sameScope(
  action: PendingWebAction,
  conversationId: string,
  siteId: string,
) {
  return (
    action.conversationScope === conversationScopeHash(conversationId) &&
    action.siteId === siteId
  );
}

function expireIfNeeded(action: PendingWebAction, now: Date) {
  if (
    action.status === "pending" &&
    new Date(action.expiresAt).getTime() <= now.getTime()
  ) {
    action.status = "expired";
  }
  return action.status === "expired";
}

function cleanup(actions: PendingWebAction[], now: Date) {
  return actions.filter((action) => {
    expireIfNeeded(action, now);
    if (action.status === "pending" || action.status === "executing") return true;
    return now.getTime() - new Date(action.createdAt).getTime() <
      TERMINAL_ACTION_RETENTION_MILLISECONDS;
  });
}

function actionsForScope(
  actions: PendingWebAction[],
  conversationId: string,
  siteId: string,
) {
  return actions
    .filter((action) => sameScope(action, conversationId, siteId))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function logLookup(
  conversationId: string,
  siteId: string,
  result: ScopedPendingActionResult,
) {
  console.log("PENDING_LOOKUP", {
    scope: conversationScopeHash(conversationId),
    siteId,
    found: result.status === "FOUND",
    status: result.status === "FOUND" ? result.action.status : result.status,
  });
}

export function createPendingWebAction({
  conversationId,
  siteId,
  pageUrl,
  matchedName,
  role,
  risk,
  now = new Date(),
}: CreatePendingActionInput): PendingWebAction {
  const actions = cleanup(loadActions(), now);
  for (const action of actionsForScope(actions, conversationId, siteId)) {
    if (action.status === "pending") action.status = "superseded";
  }

  const id = randomUUID();
  const safePageUrl = stripUrl(pageUrl);
  const fingerprint: SafeActionFingerprint = {
    siteId,
    pageUrl: safePageUrl,
    role,
    accessibleName: matchedName,
    risk,
  };
  const action: PendingWebAction = {
    id,
    conversationScope: conversationScopeHash(conversationId),
    siteId,
    requestedIntent: matchedName,
    matchedName,
    role,
    risk,
    requiredConfirmationPhrase:
      risk === "critical"
        ? buildCriticalConfirmationPhrase(matchedName)
        : undefined,
    fingerprint,
    createdAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + PENDING_ACTION_TTL_MILLISECONDS,
    ).toISOString(),
    status: "pending",
  };

  actions.push(action);
  saveActions(actions);
  console.log("ACTION_PREPARED", {
    scope: action.conversationScope,
    siteId,
    pendingId: id,
    status: action.status,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
  });
  return action;
}

export function getPendingWebAction(id: string, now = new Date()) {
  const actions = loadActions();
  const action = actions.find((candidate) => candidate.id === id);
  if (!action) return null;
  const expired = expireIfNeeded(action, now);
  if (expired) saveActions(cleanup(actions, now));
  return expired ? null : action;
}

export function getScopedPendingWebAction(
  conversationId: string,
  siteId: string,
  now = new Date(),
): ScopedPendingActionResult {
  const actions = loadActions();
  const scoped = actionsForScope(actions, conversationId, siteId);
  const pending = scoped.filter((action) => action.status === "pending");
  const changed = pending.some((action) => expireIfNeeded(action, now));
  if (changed) saveActions(cleanup(actions, now));
  const active = pending.filter((action) => action.status === "pending");
  let result: ScopedPendingActionResult;
  if (active.length > 1) result = { status: "MULTIPLE_ACTIONS_PENDING" };
  else if (active.length === 1) result = { status: "FOUND", action: active[0] };
  else {
    const latest = scoped[0];
    result = latest?.status === "expired"
      ? { status: "EXPIRED_ACTION", action: latest }
      : { status: "NO_ACTION_PENDING" };
  }
  logLookup(conversationId, siteId, result);
  return result;
}

export function getPendingActionRuntimeSummary(
  conversationId: string,
  now = new Date(),
): PendingActionRuntimeSummary {
  const scope = conversationScopeHash(conversationId);
  const actions = loadActions();
  let changed = false;
  for (const action of actions) {
    if (
      action.conversationScope === scope &&
      expireIfNeeded(action, now)
    ) {
      changed = true;
    }
  }
  if (changed) saveActions(cleanup(actions, now));
  const active = actions
    .filter(
      (action) =>
        action.conversationScope === scope && action.status === "pending",
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  if (active.length !== 1) return { exists: false };
  const [action] = active;
  return {
    exists: true,
    siteId: action.siteId,
    matchedAction: action.matchedName,
    risk: action.risk,
    expiresInSeconds: Math.max(
      0,
      Math.ceil((new Date(action.expiresAt).getTime() - now.getTime()) / 1_000),
    ),
  };
}

export function getPendingFollowUpTool(
  conversationId: string,
  latestUserMessage: string,
  now = new Date(),
) {
  const scope = conversationScopeHash(conversationId);
  const actions = loadActions();
  const changed = actions.some(
    (action) =>
      action.conversationScope === scope && expireIfNeeded(action, now),
  );
  if (changed) saveActions(cleanup(actions, now));
  const active = actions.filter(
    (action) =>
      action.conversationScope === scope && action.status === "pending",
  );
  if (active.length !== 1) return null;
  if (isExplicitCancellation(latestUserMessage)) {
    return "web_cancel_pending_action" as const;
  }
  const confirmation = parseActionConfirmation({
    message: latestUserMessage,
    risk: active[0].risk,
    requiredPhrase: active[0].requiredConfirmationPhrase,
  });
  return confirmation.explicit ? ("web_execute_pending_action" as const) : null;
}

export function transitionPendingWebAction(
  id: string,
  expected: PendingWebActionStatus,
  next: PendingWebActionStatus,
) {
  const actions = loadActions();
  const action = actions.find((candidate) => candidate.id === id);
  if (!action || action.status !== expected) return false;
  action.status = next;
  saveActions(actions);
  return true;
}

export function cancelScopedPendingWebAction(
  conversationId: string,
  siteId: string,
  now = new Date(),
): ScopedPendingActionResult {
  const result = getScopedPendingWebAction(conversationId, siteId, now);
  if (result.status !== "FOUND") return result;
  if (!transitionPendingWebAction(result.action.id, "pending", "cancelled")) {
    return { status: "NO_ACTION_PENDING" };
  }
  result.action.status = "cancelled";
  return result;
}

export function promotePendingWebActionToCritical(
  id: string,
  matchedName: string,
) {
  const actions = loadActions();
  const action = actions.find((candidate) => candidate.id === id);
  if (!action || action.status !== "executing") return null;
  action.status = "pending";
  action.risk = "critical";
  action.fingerprint.risk = "critical";
  action.requiredConfirmationPhrase = buildCriticalConfirmationPhrase(matchedName);
  saveActions(actions);
  return action;
}
