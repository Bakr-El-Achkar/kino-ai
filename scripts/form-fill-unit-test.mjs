import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  isExplicitCancellation,
  parseActionConfirmation,
} from "../lib/kino/web-agent/action-confirmation.ts";
import {
  executeValidatedFormFillPlan,
  rediscoverFormFillField,
  supportedFormFillField,
} from "../lib/kino/web-agent/form-fill-mutation.ts";
import {
  getPendingFormFillFollowUpTool,
  looksLikeFormFillRequest,
} from "../lib/kino/web-agent/form-fill-follow-up.ts";
import { formatFormFillToolResponse } from "../lib/kino/web-agent/form-fill-response.ts";
import {
  createPendingFormFill,
  cancelScopedPendingFormFill,
  FORM_FILL_TTL_MILLISECONDS,
  formFillContextChanged,
  getScopedPendingFormFill,
  transitionFormFill,
} from "../lib/kino/web-agent/pending-form-fills.ts";

function field(id, name, fieldType = "text", overrides = {}) {
  return {
    id,
    role: fieldType === "select" ? "combobox" : fieldType === "checkbox" ? "checkbox" : "textbox",
    name,
    fieldType,
    required: false,
    disabled: false,
    readonly: false,
    ...overrides,
  };
}

assert.equal(looksLikeFormFillRequest("Fill the prepared values into the form."), true);
assert.equal(looksLikeFormFillRequest("Put the prepared values in the form"), true);
assert.equal(looksLikeFormFillRequest("His email is ali@example.com"), false);
assert.equal(looksLikeFormFillRequest("Should I fill the form?"), false);
for (const confirmation of ["fill it", "yes continue", "confirm and fill"]) {
  assert.equal(parseActionConfirmation({ message: confirmation, risk: "write" }).explicit, true);
}
assert.equal(isExplicitCancellation("Don't fill it."), true);
assert.equal(
  parseActionConfirmation({ message: "yes, do not fill it", risk: "write" }).explicit,
  false,
);

for (const type of ["text", "email", "tel", "number", "textarea", "date", "datetime", "select", "checkbox"]) {
  const options = type === "select" ? ["North"] : undefined;
  assert.equal(supportedFormFillField(field(type, type, type, { options })), true, type);
}
for (const type of ["radio", "switch", "unknown"]) {
  assert.equal(supportedFormFillField(field(type, type, type)), false, type);
}

const identity = { draftFieldId: "email", name: "Email address", role: "textbox", fieldType: "email" };
const emailLive = { field: field("email", "Email address", "email"), locator: {} };
assert.equal(rediscoverFormFillField(identity, [emailLive]).status, "MATCHED");
assert.equal(
  rediscoverFormFillField(identity, [emailLive, { ...emailLive, field: field("other", "Email address", "email") }]).status,
  "FIELD_AMBIGUOUS",
);
assert.equal(rediscoverFormFillField(identity, []).status, "FIELD_NOT_AVAILABLE");

const createdAt = new Date("2026-01-01T00:00:00.000Z");
const conversationId = "form-fill-secret-conversation";
const draft = {
  id: "draft-a",
  conversationScope: "already-hashed",
  siteId: "example",
  pageUrl: "https://example.com/form",
  formFingerprint: "fingerprint-a",
  formName: "Profile",
  fields: [field("name", "Name")],
  provided: [{ fieldId: "name", field: "Name", fieldType: "text", value: "Secret Draft Value", source: "user" }],
  missingRequired: ["Password"],
  issues: [],
  status: "DRAFT_INCOMPLETE",
  createdAt: createdAt.toISOString(),
  updatedAt: createdAt.toISOString(),
  expiresAt: new Date(createdAt.getTime() + 900_000).toISOString(),
};
const pending = createPendingFormFill({
  conversationId,
  siteId: "example",
  draft,
  fields: [{ draftFieldId: "name", name: "Name", role: "textbox", fieldType: "text" }],
  now: createdAt,
});
assert.equal(pending.risk, "write");
assert.equal(pending.draftId, draft.id);
assert.equal(pending.draftUpdatedAt, draft.updatedAt);
assert.equal(getScopedPendingFormFill(conversationId, "example", createdAt).status, "FOUND");
assert.equal(
  getPendingFormFillFollowUpTool(conversationId, "I confirm", createdAt),
  "web_execute_form_fill",
);
assert.equal(
  getPendingFormFillFollowUpTool(conversationId, "Don't fill it", createdAt),
  "web_cancel_form_fill",
);
assert.equal(transitionFormFill(pending.id, "pending", "executing"), true);
assert.equal(transitionFormFill(pending.id, "pending", "executing"), false);
assert.equal(transitionFormFill(pending.id, "executing", "executed", { verifiedCount: 1, failedCount: 0 }), true);
assert.equal(getScopedPendingFormFill(conversationId, "example", createdAt).status, "NO_FORM_FILL_PENDING");
assert.equal(
  getPendingFormFillFollowUpTool(conversationId, "Yes", new Date()),
  "web_execute_form_fill",
);
assert.equal(
  formFillContextChanged(pending, draft, draft.pageUrl, draft.formFingerprint),
  false,
);
assert.equal(
  formFillContextChanged(pending, draft, "https://example.com/elsewhere", draft.formFingerprint),
  true,
);
assert.equal(
  formFillContextChanged(pending, { ...draft, updatedAt: new Date().toISOString() }, draft.pageUrl, draft.formFingerprint),
  true,
);

createPendingFormFill({
  conversationId: "expiring-form-fill",
  siteId: "example",
  draft,
  fields: [{ draftFieldId: "name", name: "Name", role: "textbox", fieldType: "text" }],
  now: createdAt,
});
assert.equal(
  getScopedPendingFormFill(
    "expiring-form-fill",
    "example",
    new Date(createdAt.getTime() + FORM_FILL_TTL_MILLISECONDS),
  ).status,
  "FORM_FILL_EXPIRED",
);

createPendingFormFill({
  conversationId: "cancel-form-fill",
  siteId: "example",
  draft,
  fields: [{ draftFieldId: "name", name: "Name", role: "textbox", fieldType: "text" }],
  now: createdAt,
});
const cancelled = cancelScopedPendingFormFill("cancel-form-fill", "example", createdAt);
assert.equal(cancelled.status, "FOUND");
if (cancelled.status === "FOUND") assert.equal(cancelled.fill.status, "cancelled");
assert.equal(getScopedPendingFormFill("cancel-form-fill", "example", createdAt).status, "NO_FORM_FILL_PENDING");

const persisted = readFileSync(".kino/runtime/pending-form-fills.json", "utf8");
assert.equal(persisted.includes(conversationId), false);
assert.equal(persisted.includes("Secret Draft Value"), false);
assert.equal(persisted.includes("selector"), false);

function textLocator({ enabled = true } = {}) {
  let value = "";
  let fillCalls = 0;
  return {
    get fillCalls() { return fillCalls; },
    async isVisible() { return true; },
    async isEnabled() { return enabled; },
    async getAttribute() { return null; },
    async fill(next) { fillCalls += 1; value = next; },
    async inputValue() { return value; },
  };
}

function item(id, locator) {
  return {
    identity: { draftFieldId: id, name: id, role: "textbox", fieldType: "text" },
    value: { fieldId: id, field: id, fieldType: "text", value: id.toUpperCase(), source: "user" },
    live: { field: field(id, id), locator },
  };
}

const first = textLocator();
const second = textLocator({ enabled: false });
const third = textLocator();
const partial = await executeValidatedFormFillPlan([
  item("first", first),
  item("second", second),
  item("third", third),
]);
assert.equal(partial.status, "partial");
assert.equal(partial.completed.length, 1);
assert.equal(partial.failed.identity.name, "second");
assert.deepEqual(partial.notAttempted.map(({ identity: value }) => value.name), ["third"]);
assert.equal(first.fillCalls, 1);
assert.equal(second.fillCalls, 0);
assert.equal(third.fillCalls, 0);

const preparedResponse = formatFormFillToolResponse({
  result: {
    success: true,
    status: "FORM_FILL_PENDING_CONFIRMATION",
    fill: {
      fields: [{ field: "Name" }, { field: "Email" }],
      requiredNotFilled: ["Password"],
    },
  },
});
assert.match(preparedResponse, /Confirm to continue/);
assert.match(preparedResponse, /Nothing has been filled or submitted yet/);
assert.doesNotMatch(preparedResponse, /Secret Draft Value/);

const completedResponse = formatFormFillToolResponse({
  result: {
    success: true,
    status: "FORM_FILL_COMPLETED",
    filled: [{ field: "Name", filled: true, verified: true }],
    notFilled: [{ field: "Password", reason: "sensitive" }],
  },
});
assert.match(completedResponse, /Filled and verified:\n- Name/);
assert.match(completedResponse, /Password/);
assert.match(completedResponse, /NOT been submitted/);

console.log("Form-fill unit tests passed.");
