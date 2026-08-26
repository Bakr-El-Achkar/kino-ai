import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { getActionAuditEvents, recordActionAuditEvent } from "../lib/kino/web-agent/audit.ts";
import {
  cancelSensitiveFormFillRequest,
  clearEphemeralSensitiveStateForTests,
  createSensitiveFormFillRequest,
  getExecutingSensitiveValue,
  getSensitiveFormFillRequest,
  getSensitiveFormFillRuntimeSummary,
  sensitiveFormContextChanged,
  settleSensitiveFormFill,
  stageSensitiveFormValue,
  transitionSensitiveFormFill,
} from "../lib/kino/web-agent/ephemeral-secrets.ts";
import { classifySensitiveFillEligibility } from "../lib/kino/web-agent/sensitive-field-policy.ts";
import {
  fillSensitiveField,
  verifySensitiveField,
} from "../lib/kino/web-agent/sensitive-form-mutation.ts";
import {
  getSensitiveFormFillFollowUpTool,
  requestedSensitiveField,
} from "../lib/kino/web-agent/sensitive-form-follow-up.ts";
import { formatSensitiveFormFillResponse } from "../lib/kino/web-agent/sensitive-form-response.ts";

function field(name, fieldType = "password", overrides = {}) {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    role: "textbox",
    name,
    fieldType,
    controlKind: "input",
    required: true,
    disabled: false,
    readonly: false,
    ...overrides,
  };
}

for (const candidate of [
  field("Password"),
  field("Account passcode", "text"),
  field("Security PIN", "number"),
]) {
  assert.deepEqual(classifySensitiveFillEligibility(candidate), {
    eligible: true,
    category: "authentication_secret",
  });
}
for (const name of ["Credit Card", "CVV", "API Key", "Bank Account", "Government ID", "Access Token", "Private Key"]) {
  const result = classifySensitiveFillEligibility(field(name, "text"));
  assert.equal(result.eligible, false, name);
  if (!result.eligible) assert.equal(result.reason, "BLOCKED_CATEGORY", name);
}
assert.equal(classifySensitiveFillEligibility(field("Display name", "text")).eligible, false);
assert.equal(classifySensitiveFillEligibility(field("Password", "select")).eligible, false);

assert.equal(requestedSensitiveField("Fill the remaining password."), "Password");
assert.equal(requestedSensitiveField("Please enter the passcode"), "Passcode");
assert.equal(requestedSensitiveField("Fill the PIN"), "PIN");
assert.equal(requestedSensitiveField("Fill the remaining sensitive field"), "");
assert.equal(requestedSensitiveField("My password is something"), null);

clearEphemeralSensitiveStateForTests();
const now = new Date("2026-01-01T00:00:00.000Z");
const conversationId = "123e4567-e89b-42d3-a456-426614174222";
const secret = `Sensitive-Test-${Date.now()}-Only`;
const identity = {
  fieldFingerprint: "field-fingerprint",
  name: "Password",
  role: "textbox",
  fieldType: "password",
  required: true,
  constraints: { minLength: 8, maxLength: 100 },
};
const request = createSensitiveFormFillRequest({
  conversationId,
  siteId: "example",
  pageUrl: "https://example.com/form",
  formFingerprint: "form-fingerprint",
  field: identity,
  now,
  ttlMilliseconds: 1_000,
});
assert.equal(request.stage, "awaiting_secure_value");
assert.equal(JSON.stringify(request).includes(secret), false);
assert.equal(
  getSensitiveFormFillFollowUpTool(conversationId, "Don't fill it", now),
  "web_cancel_sensitive_form_fill",
);

const tooShort = stageSensitiveFormValue({
  conversationId,
  secureRequestId: request.secureRequestId,
  value: "short",
  now,
  ttlMilliseconds: 1_000,
});
assert.equal(tooShort.status, "SENSITIVE_VALUE_CONSTRAINT_FAILED");
const staged = stageSensitiveFormValue({
  conversationId,
  secureRequestId: request.secureRequestId,
  value: secret,
  now,
  ttlMilliseconds: 1_000,
});
assert.equal(staged.status, "SENSITIVE_VALUE_STAGED");
assert.equal(JSON.stringify(staged).includes(secret), false);
assert.equal(getSensitiveFormFillRuntimeSummary(conversationId, now).stage, "awaiting_confirmation");
assert.equal(JSON.stringify(getSensitiveFormFillRuntimeSummary(conversationId, now)).includes(secret), false);
assert.equal(
  getSensitiveFormFillFollowUpTool(conversationId, "I confirm", now),
  "web_execute_sensitive_form_fill",
);
assert.equal(transitionSensitiveFormFill(request.secureRequestId, "awaiting_confirmation", "executing"), true);
assert.equal(transitionSensitiveFormFill(request.secureRequestId, "awaiting_confirmation", "executing"), false);
assert.equal(getExecutingSensitiveValue(conversationId, request.secureRequestId), secret);
assert.deepEqual(
  settleSensitiveFormFill(request.secureRequestId, "executed", { filled: true, verified: true }),
  { found: true, secretDiscarded: true },
);
assert.equal(getExecutingSensitiveValue(conversationId, request.secureRequestId), null);
assert.equal(getSensitiveFormFillRuntimeSummary(conversationId, now).stage, "executed");
assert.equal(
  getSensitiveFormFillFollowUpTool(conversationId, "Yes", now),
  "web_execute_sensitive_form_fill",
);

assert.equal(
  sensitiveFormContextChanged(request, {
    pageUrl: request.pageUrl,
    formFingerprint: request.formFingerprint,
    fieldFingerprint: identity.fieldFingerprint,
    fieldName: identity.name,
    role: identity.role,
    fieldType: identity.fieldType,
  }),
  false,
);
assert.equal(
  sensitiveFormContextChanged(request, {
    pageUrl: "https://example.com/elsewhere",
    formFingerprint: request.formFingerprint,
    fieldFingerprint: identity.fieldFingerprint,
    fieldName: identity.name,
    role: identity.role,
    fieldType: identity.fieldType,
  }),
  true,
);

const cancellationConversation = "123e4567-e89b-42d3-a456-426614174223";
const cancellationRequest = createSensitiveFormFillRequest({
  conversationId: cancellationConversation,
  siteId: "example",
  pageUrl: "https://example.com/form",
  formFingerprint: "form-fingerprint",
  field: identity,
  now,
});
stageSensitiveFormValue({
  conversationId: cancellationConversation,
  secureRequestId: cancellationRequest.secureRequestId,
  value: secret,
  now,
});
const cancelled = cancelSensitiveFormFillRequest(
  cancellationConversation,
  cancellationRequest.secureRequestId,
  now,
);
assert.equal(cancelled.status, "SENSITIVE_FILL_CANCELLED");
if (cancelled.status === "SENSITIVE_FILL_CANCELLED") {
  assert.equal(cancelled.secretDiscarded, true);
}
assert.equal(getExecutingSensitiveValue(cancellationConversation, cancellationRequest.secureRequestId), null);

const expiryConversation = "123e4567-e89b-42d3-a456-426614174224";
const expiryRequest = createSensitiveFormFillRequest({
  conversationId: expiryConversation,
  siteId: "example",
  pageUrl: "https://example.com/form",
  formFingerprint: "form-fingerprint",
  field: identity,
  now,
  ttlMilliseconds: 5,
});
stageSensitiveFormValue({
  conversationId: expiryConversation,
  secureRequestId: expiryRequest.secureRequestId,
  value: secret,
  now,
  ttlMilliseconds: 5,
});
const expired = getSensitiveFormFillRequest(
  expiryConversation,
  expiryRequest.secureRequestId,
  new Date(now.getTime() + 6),
);
assert.equal(expired.status, "SENSITIVE_VALUE_EXPIRED");
if (expired.status === "SENSITIVE_VALUE_EXPIRED") assert.equal(expired.secretDiscarded, true);
assert.equal(getExecutingSensitiveValue(expiryConversation, expiryRequest.secureRequestId), null);

let browserValue = "";
const fakeLocator = {
  async fill(value) { browserValue = value; },
  async inputValue() { return browserValue; },
};
await fillSensitiveField(fakeLocator, secret);
assert.equal(await verifySensitiveField(fakeLocator, secret), true);

recordActionAuditEvent({
  conversationId,
  siteId: "example",
  fieldName: "Password",
  status: "SENSITIVE_FIELD_VERIFIED",
});
assert.equal(JSON.stringify(getActionAuditEvents()).includes(secret), false);

const runtimeDirectory = resolve(".kino/runtime");
for (const name of readdirSync(runtimeDirectory).filter((entry) => entry.endsWith(".json"))) {
  assert.equal(readFileSync(resolve(runtimeDirectory, name), "utf8").includes(secret), false, name);
}

const safeResponse = formatSensitiveFormFillResponse({
  result: {
    success: true,
    status: "SENSITIVE_FILL_COMPLETED",
    field: "Password",
    filled: true,
    verified: true,
  },
});
assert.match(safeResponse, /Password was filled and verified/);
assert.match(safeResponse, /NOT been submitted/);
assert.equal(safeResponse.includes(secret), false);

const restartConversation = "123e4567-e89b-42d3-a456-426614174225";
createSensitiveFormFillRequest({
  conversationId: restartConversation,
  siteId: "example",
  pageUrl: "https://example.com/form",
  formFingerprint: "form-fingerprint",
  field: identity,
  now,
});
clearEphemeralSensitiveStateForTests();
assert.deepEqual(getSensitiveFormFillRuntimeSummary(restartConversation, now), { exists: false });

const toolSource = readFileSync("lib/kino/tools/web-agent.ts", "utf8");
assert.doesNotMatch(toolSource, /web_execute_sensitive_form_fill/);
assert.doesNotMatch(toolSource, /username|password/);
const loginRouteSource = readFileSync("app/api/kino/browser-login/route.ts", "utf8");
assert.match(loginRouteSource, /delete payload\.username/);
assert.match(loginRouteSource, /delete payload\.password/);
assert.match(loginRouteSource, /username = ""/);
assert.match(loginRouteSource, /password = ""/);

console.log("Sensitive form-fill unit tests passed.");
