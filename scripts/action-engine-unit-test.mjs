import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createChatToolContext,
  latestActualUserMessage,
} from "../lib/kino/tools/execution-context.ts";

import { matchWebAction, normalizeActionText } from "../lib/kino/web-agent/action-matcher.ts";
import { classifyActionRisk } from "../lib/kino/web-agent/action-risk.ts";
import {
  buildCriticalConfirmationPhrase,
  isExplicitCancellation,
  parseActionConfirmation,
  requestsPostConfirmationInspection,
} from "../lib/kino/web-agent/action-confirmation.ts";
import { requiresConfirmation } from "../lib/kino/web-agent/confirmation-policy.ts";
import { normalizeNavigationTarget } from "../lib/kino/web-agent/navigation-target.ts";
import {
  formatBrowserCommandResponse,
  resolveFastBrowserCommand,
} from "../lib/kino/web-agent/fast-browser-routing.ts";
import {
  createPendingWebAction,
  cancelScopedPendingWebAction,
  getPendingFollowUpTool,
  getPendingWebAction,
  getScopedPendingWebAction,
  PENDING_ACTION_TTL_MILLISECONDS,
  transitionPendingWebAction,
} from "../lib/kino/web-agent/pending-actions.ts";

function candidate(id, name, role = "button") {
  const classification = classifyActionRisk({ name, role, destination: "none" });
  return { id, name, role, destination: "none", ...classification };
}

const realMessages = [
  { role: "user", content: "Add a customer" },
  { role: "assistant", content: "Confirm?" },
  { role: "user", content: "Yes, continue." },
];
const latestUserMessage = latestActualUserMessage(realMessages);
assert.equal(latestUserMessage, "Yes, continue.");
assert.equal(
  createChatToolContext({
    conversationId: "123e4567-e89b-42d3-a456-426614174000",
    latestUserMessage,
  }).latestUserMessage,
  "Yes, continue.",
);
assert.equal(
  createChatToolContext({
    conversationId: "123e4567-e89b-42d3-a456-426614174000",
    latestUserMessage: "message two",
  }).conversationId,
  "123e4567-e89b-42d3-a456-426614174000",
);

for (const target of [
  "Customers",
  "customers section",
  "customer section",
  "customers page",
  "open customers",
  "go to customers",
  "take me to customers",
  "show customers",
]) {
  assert.ok(["Customers", "customers", "customer"].includes(normalizeNavigationTarget(target)));
}
assert.equal(normalizeNavigationTarget("Bookings section"), "Bookings");
assert.equal(normalizeNavigationTarget("navigate to the bookings page"), "bookings");

const connectedSites = [{ id: "cleannest", name: "CleanNest" }];
assert.deepEqual(resolveFastBrowserCommand("Open CleanNest", connectedSites), {
  tool: "web_open_site",
  args: { site: "cleannest" },
});
assert.deepEqual(
  resolveFastBrowserCommand("Open the customers section", connectedSites),
  { tool: "web_navigate", args: { target: "customers" } },
);
assert.equal(
  resolveFastBrowserCommand("Open the Add customer form", connectedSites),
  null,
);
assert.equal(
  resolveFastBrowserCommand(
    "Open customers and tell me what you see",
    connectedSites,
  ),
  null,
);
assert.equal(
  formatBrowserCommandResponse("web_navigate", {
    result: {
      success: true,
      matched: "Customers",
      site: { name: "CleanNest" },
    },
  }),
  "Opened Customers in CleanNest.",
);

assert.equal(normalizeActionText("  Add—a CUSTOMER!  "), "add a customer");

const addCustomer = candidate("1", "Add Customer");
const matched = matchWebAction("Add a customer", [addCustomer]);
assert.equal(matched.status, "MATCHED");
if (matched.status === "MATCHED") assert.equal(matched.candidate.name, "Add Customer");

const ambiguous = matchWebAction("Add a customer", [
  candidate("1", "Add Customer", "button"),
  candidate("2", "Add Customer", "menuitem"),
]);
assert.deepEqual(ambiguous, {
  status: "AMBIGUOUS_ACTION",
  candidates: ["Add Customer"],
});

const noMatch = matchWebAction("Launch nuclear mode", [addCustomer]);
assert.equal(noMatch.status, "NO_ACTION_MATCH");

for (const name of [
  "Delete Customer",
  "Refund Payment",
  "Block User",
  "Remove Account",
]) {
  assert.equal(classifyActionRisk({ name, role: "button" }).risk, "critical");
}
assert.equal(classifyActionRisk({ name: "Add Customer", role: "button" }).risk, "write");
assert.equal(
  classifyActionRisk({
    name: "Customers",
    role: "link",
    destination: "same-origin",
  }).risk,
  "read",
);

assert.equal(requiresConfirmation("read"), false);
assert.equal(requiresConfirmation("write"), true);
assert.equal(requiresConfirmation("critical"), true);

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const pending = createPendingWebAction({
  conversationId: "conversation-a",
  siteId: "example",
  pageUrl: "https://example.com/customers?token=secret#private",
  requestedIntent: "Add a customer",
  matchedName: "Add Customer",
  role: "button",
  risk: "write",
  now: createdAt,
});
assert.equal(pending.fingerprint.pageUrl, "https://example.com/customers");
assert.equal(getPendingWebAction(pending.id, createdAt)?.status, "pending");
assert.equal(
  getPendingWebAction(
    pending.id,
    new Date(createdAt.getTime() + PENDING_ACTION_TTL_MILLISECONDS),
  ),
  null,
);

assert.deepEqual(
  parseActionConfirmation({ message: "Yes, continue.", risk: "write" }),
  { explicit: true, kind: "standard" },
);
for (const confirmation of [
  "yes",
  "yes proceed",
  "confirm it",
  "confirm this",
  "confirm this process",
  "confirm the action",
  "I confirm",
  "I confirm it",
  "I confirm this",
  "I confirm this process",
  "I confirm the action",
  "go ahead",
  "continue with it",
  "continue the process",
  "نعم",
  "نعم أكمل",
  "أؤكد العملية",
  "نفّذ",
]) {
  assert.equal(
    parseActionConfirmation({ message: confirmation, risk: "write" }).explicit,
    true,
    confirmation,
  );
}
for (const confirmation of [
  "confirmed so open it",
  "I confirm, continue",
  "confirmed, proceed",
  "yes open it",
  "I confirm this, open the form",
  "confirm and continue",
  "confirmed so open it and tell me what you can see",
  "confirmed so open the Add new customer form and tell me what you can see",
]) {
  assert.equal(
    parseActionConfirmation({ message: confirmation, risk: "write" }).explicit,
    true,
    confirmation,
  );
}
assert.deepEqual(
  parseActionConfirmation({ message: "yes, but don't continue", risk: "write" }),
  { explicit: false, reason: "CONFIRMATION_NEGATED" },
);
for (const rejection of [
  "no",
  "don't continue",
  "do not continue",
  "not yet",
  "maybe",
  "probably",
  "I think so",
  "what if I confirm?",
  "should I confirm?",
  "I don't confirm",
  "I do not confirm",
  "yes, but don't continue",
]) {
  assert.equal(
    parseActionConfirmation({ message: rejection, risk: "write" }).explicit,
    false,
    rejection,
  );
}
assert.deepEqual(
  parseActionConfirmation({ message: "maybe yes", risk: "write" }),
  { explicit: false, reason: "CONFIRMATION_NOT_EXPLICIT" },
);
for (const rejection of [
  "don't open it",
  "do not continue",
  "maybe open it",
  "should I confirm?",
  "I don't confirm",
]) {
  assert.equal(
    parseActionConfirmation({ message: rejection, risk: "write" }).explicit,
    false,
    rejection,
  );
}
assert.deepEqual(
  parseActionConfirmation({
    message: "What happens if I continue?",
    risk: "write",
  }),
  { explicit: false, reason: "CONFIRMATION_NOT_EXPLICIT" },
);
assert.equal(isExplicitCancellation("No, cancel."), true);
assert.equal(isExplicitCancellation("Never mind"), true);
assert.equal(
  requestsPostConfirmationInspection(
    "confirmed so open it and tell me what you can see",
  ),
  true,
);
assert.equal(requestsPostConfirmationInspection("confirmed so open it"), false);
assert.deepEqual(
  parseActionConfirmation({ message: "نعم أكمل", risk: "write" }),
  { explicit: true, kind: "standard" },
);

const criticalPhrase = buildCriticalConfirmationPhrase("Refund Payment for Jane Doe");
assert.equal(criticalPhrase, "CONFIRM REFUND PAYMENT");
assert.deepEqual(
  parseActionConfirmation({
    message: "Yes",
    risk: "critical",
    requiredPhrase: criticalPhrase,
  }),
  { explicit: false, reason: "STRONG_CONFIRMATION_REQUIRED" },
);
assert.deepEqual(
  parseActionConfirmation({
    message: criticalPhrase,
    risk: "critical",
    requiredPhrase: criticalPhrase,
  }),
  { explicit: true, kind: "strong" },
);
const cancelOrderPhrase = buildCriticalConfirmationPhrase("Cancel Order");
assert.deepEqual(
  parseActionConfirmation({
    message: cancelOrderPhrase,
    risk: "critical",
    requiredPhrase: cancelOrderPhrase,
  }),
  { explicit: true, kind: "strong" },
);

createPendingWebAction({
  conversationId: "combined-confirmation-scope",
  siteId: "scope-site",
  pageUrl: "https://example.com/current",
  requestedIntent: "Open form",
  matchedName: "Open form",
  role: "button",
  risk: "write",
  now: createdAt,
});
assert.equal(
  getPendingFollowUpTool(
    "combined-confirmation-scope",
    "confirmed so open it and tell me what you can see",
    createdAt,
  ),
  "web_execute_pending_action",
);
assert.equal(
  getPendingFollowUpTool(
    "combined-confirmation-scope",
    "don't open it",
    createdAt,
  ),
  null,
);

const criticalFollowUp = createPendingWebAction({
  conversationId: "critical-confirmation-scope",
  siteId: "scope-site",
  pageUrl: "https://example.com/current",
  requestedIntent: "Refund payment",
  matchedName: "Refund Payment",
  role: "button",
  risk: "critical",
  now: createdAt,
});
assert.equal(
  getPendingFollowUpTool("critical-confirmation-scope", "yes open it", createdAt),
  null,
);
assert.equal(
  getPendingFollowUpTool(
    "critical-confirmation-scope",
    criticalFollowUp.requiredConfirmationPhrase,
    createdAt,
  ),
  "web_execute_pending_action",
);

const scoped = createPendingWebAction({
  conversationId: "scope-a",
  siteId: "scope-site",
  pageUrl: "https://example.com/current",
  requestedIntent: "Add record",
  matchedName: "Add record",
  role: "button",
  risk: "write",
  now: createdAt,
});
assert.equal(
  getScopedPendingWebAction("scope-b", "scope-site", createdAt).status,
  "NO_ACTION_PENDING",
);
assert.equal(
  getScopedPendingWebAction("scope-a", "scope-site", createdAt).status,
  "FOUND",
);

const replacement = createPendingWebAction({
  conversationId: "scope-a",
  siteId: "scope-site",
  pageUrl: "https://example.com/current",
  requestedIntent: "Edit record",
  matchedName: "Edit record",
  role: "button",
  risk: "write",
  now: new Date(createdAt.getTime() + 1),
});
assert.equal(getPendingWebAction(scoped.id, createdAt)?.status, "superseded");
assert.equal(replacement.status, "pending");

const cancelled = cancelScopedPendingWebAction(
  "scope-a",
  "scope-site",
  createdAt,
);
assert.equal(cancelled.status, "FOUND");
if (cancelled.status === "FOUND") assert.equal(cancelled.action.status, "cancelled");
assert.equal(
  getScopedPendingWebAction("scope-a", "scope-site", createdAt).status,
  "NO_ACTION_PENDING",
);

const singleUse = createPendingWebAction({
  conversationId: "single-use",
  siteId: "scope-site",
  pageUrl: "https://example.com/current",
  requestedIntent: "Add record",
  matchedName: "Add record",
  role: "button",
  risk: "write",
  now: createdAt,
});
assert.equal(transitionPendingWebAction(singleUse.id, "pending", "executing"), true);
assert.equal(transitionPendingWebAction(singleUse.id, "pending", "executing"), false);
assert.equal(transitionPendingWebAction(singleUse.id, "executing", "executed"), true);
assert.equal(
  getScopedPendingWebAction("single-use", "scope-site", createdAt).status,
  "NO_ACTION_PENDING",
);

createPendingWebAction({
  conversationId: "expired",
  siteId: "scope-site",
  pageUrl: "https://example.com/current",
  requestedIntent: "Add record",
  matchedName: "Add record",
  role: "button",
  risk: "write",
  now: createdAt,
});
assert.equal(
  getScopedPendingWebAction(
    "expired",
    "scope-site",
    new Date(createdAt.getTime() + PENDING_ACTION_TTL_MILLISECONDS),
  ).status,
  "EXPIRED_ACTION",
);

createPendingWebAction({
  conversationId: "persistent-secret-conversation",
  siteId: "persistence-site",
  pageUrl: "https://example.com/current?private=value",
  requestedIntent: "Add Ali with private details",
  matchedName: "Add record",
  role: "button",
  risk: "write",
  now: new Date(),
});
assert.equal(
  getScopedPendingWebAction(
    "persistent-secret-conversation",
    "persistence-site",
  ).status,
  "FOUND",
);
const persistedStore = readFileSync(
  new URL("../.kino/runtime/pending-actions.json", import.meta.url),
  "utf8",
);
assert.equal(persistedStore.includes("persistent-secret-conversation"), false);
assert.equal(persistedStore.includes("Ali with private details"), false);
assert.equal(persistedStore.includes("private=value"), false);

console.log("Action engine unit tests passed.");
