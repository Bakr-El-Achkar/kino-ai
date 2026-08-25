import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FORM_DRAFT_TTL_MILLISECONDS,
  formDraftContextChanged,
  getFormDraftRuntimeSummary,
  getScopedFormDraft,
  persistFormDraft,
} from "../lib/kino/web-agent/form-drafts.ts";
import {
  isSensitiveFormField,
  matchFormField,
} from "../lib/kino/web-agent/form-matcher.ts";
import {
  generateSafeTestValue,
  validateFormValue,
} from "../lib/kino/web-agent/form-validation.ts";
import { formatFormDraftToolResponse } from "../lib/kino/web-agent/form-response.ts";
import {
  looksLikeFormDraftValueFollowUp,
  parseNamedFormDraftValue,
} from "../lib/kino/web-agent/form-follow-up.ts";

function field(id, name, fieldType = "text", overrides = {}) {
  return {
    id,
    role: fieldType === "select" ? "combobox" : "textbox",
    name,
    fieldType,
    required: false,
    disabled: false,
    readonly: false,
    ...overrides,
  };
}

assert.deepEqual(parseNamedFormDraftValue("the name is Ali"), {
  field: "name",
  value: "Ali",
});
assert.deepEqual(parseNamedFormDraftValue("his address is Tripoli"), {
  field: "address",
  value: "Tripoli",
});
assert.equal(looksLikeFormDraftValueFollowUp("76122122"), true);
assert.equal(looksLikeFormDraftValueFollowUp("should I add an address?"), false);
assert.equal(parseNamedFormDraftValue("what is the address?"), null);

const fields = [
  field("name", "Name"),
  field("email", "Email address", "email"),
  field("phone", "Phone number", "tel"),
];
assert.equal(matchFormField("full name", fields).status, "MATCHED");
assert.equal(matchFormField("email", fields).status, "MATCHED");
assert.equal(matchFormField("telephone", fields).status, "MATCHED");

const ambiguousAddress = matchFormField("Address", [
  field("billing", "Billing Address"),
  field("shipping", "Shipping Address"),
]);
assert.deepEqual(ambiguousAddress, {
  status: "FIELD_AMBIGUOUS",
  candidates: ["Billing Address", "Shipping Address"],
});
assert.equal(matchFormField("Unknown concept", fields).status, "FIELD_NOT_FOUND");

for (const name of [
  "Password",
  "Credit Card",
  "CVV",
  "Bank Account",
  "Government ID",
  "Authentication Token",
  "API Key",
]) {
  assert.equal(isSensitiveFormField({ name }), true, name);
}
assert.equal(isSensitiveFormField({ name: "Account display name" }), false);

assert.equal(validateFormValue(field("email", "Email", "email"), "not-email").valid, false);
assert.deepEqual(
  validateFormValue(field("number", "Quantity", "number", { constraints: { min: 2 } }), 1),
  { valid: false, message: "Quantity must be at least 2." },
);
assert.equal(validateFormValue(field("date", "Date", "date"), "2026-02-30").valid, false);
assert.deepEqual(
  validateFormValue(
    field("select", "Region", "select", { options: ["North", "South"] }),
    "south",
  ),
  { valid: true, value: "South" },
);
assert.deepEqual(validateFormValue(field("toggle", "Enabled", "switch"), "yes"), {
  valid: true,
  value: true,
});

const generatedEmail = generateSafeTestValue(field("email", "Email", "email"));
assert.equal(generatedEmail.valid, true);
if (generatedEmail.valid) assert.match(generatedEmail.value, /^kino-test-[a-f0-9]+@example\.com$/);
const generatedText = generateSafeTestValue(field("text", "Display label", "text"));
assert.deepEqual(generatedText, { valid: true, value: "KINO Test" });
assert.equal(generateSafeTestValue(field("unknown", "Unrecognized", "unknown")).valid, false);

const now = new Date();
const conversationId = `form-draft-secret-${now.getTime()}`;
const descriptor = {
  siteId: "form-test-site",
  pageUrl: "https://example.com/form",
  title: "Test form",
  formName: "Profile form",
  scope: "form",
  fingerprint: "semantic-fingerprint-a",
  fields: [
    field("name", "Display name", "text", { required: true }),
    field("email", "Email", "email", { required: true }),
  ],
  submitControls: [{ role: "button", name: "Save", risk: "write" }],
};
const stored = persistFormDraft({
  conversationId,
  siteId: descriptor.siteId,
  form: descriptor,
  provided: [
    {
      fieldId: "name",
      field: "Display name",
      fieldType: "text",
      value: "KINO Test",
      source: "generated_test",
    },
  ],
  missingRequired: ["Email"],
  issues: [],
  status: "DRAFT_INCOMPLETE",
  now,
});
assert.equal(
  new Date(stored.expiresAt).getTime() - now.getTime(),
  FORM_DRAFT_TTL_MILLISECONDS,
);
assert.equal(getScopedFormDraft(conversationId, descriptor.siteId, now).status, "FOUND");
assert.deepEqual(getFormDraftRuntimeSummary(conversationId, now), {
  exists: true,
  siteId: descriptor.siteId,
  status: "DRAFT_INCOMPLETE",
  missingRequired: 1,
  expiresInSeconds: FORM_DRAFT_TTL_MILLISECONDS / 1_000,
});
assert.equal(formDraftContextChanged(stored, descriptor.pageUrl, descriptor.fingerprint), false);
assert.equal(formDraftContextChanged(stored, "https://example.com/elsewhere"), true);
assert.equal(formDraftContextChanged(stored, descriptor.pageUrl, "changed-fingerprint"), true);

const persisted = readFileSync(".kino/runtime/form-drafts.json", "utf8");
assert.equal(persisted.includes(conversationId), false);
assert.equal(persisted.includes("PasswordValueThatMustNeverPersist"), false);
assert.equal(persisted.includes("selector"), false);

assert.equal(
  formatFormDraftToolResponse({
    success: true,
    result: {
      success: false,
      status: "FORM_CONTEXT_CHANGED",
    },
  }),
  "The form draft was not updated because the current page or visible form changed. Reopen the intended form and prepare a new draft. Nothing has been entered or submitted.",
);
const groundedReview = formatFormDraftToolResponse({
  success: true,
  result: {
    success: true,
    status: "DRAFT_INCOMPLETE",
    form: {
      fields: [field("name", "Display name", "text", { required: true })],
      submitControls: [{ name: "Save" }],
    },
    draft: {
      status: "DRAFT_INCOMPLETE",
      provided: [
        {
          field: "Display name",
          value: "KINO Test",
          source: "generated_test",
        },
      ],
      missingRequired: [],
      issues: [],
    },
  },
});
assert.match(groundedReview, /Display name: "KINO Test" \(generated test\)/);
assert.match(
  groundedReview,
  /Nothing has been entered or submitted(?: yet)?\./,
);

const completeVisibleState = formatFormDraftToolResponse({
  success: true,
  result: {
    success: true,
    status: "DRAFT_INCOMPLETE",
    form: {
      fields: [
        field("name", "Full name", "text", { required: true }),
        field("email", "Email", "email", { required: true }),
        field("phone", "Phone", "tel", { required: true }),
        field("address", "Address", "text", { required: true }),
        field("password", "Password", "unknown", {
          required: true,
          sensitive: true,
        }),
      ],
      submitControls: [{ name: "Create" }],
    },
    draft: {
      status: "DRAFT_INCOMPLETE",
      provided: [
        { field: "Full name", value: "Ali", source: "user" },
        { field: "Email", value: "ali12@gmail.com", source: "user" },
        { field: "Phone", value: "76122122", source: "user" },
        { field: "Address", value: "Tripoli", source: "user" },
      ],
      missingRequired: ["Password"],
      sensitiveMissing: ["Password"],
      issues: [],
    },
  },
});
assert.match(completeVisibleState, /Address: "Tripoli" \(user\)/);
assert.match(completeVisibleState, /Still required:\n- Password/);
assert.match(
  completeVisibleState,
  /Password is sensitive and has not been stored or generated\./,
);
assert.doesNotMatch(
  completeVisibleState.replace(
    "Nothing has been entered or submitted yet.",
    "",
  ),
  /\b(?:entered|filled|typed|populated)\b/i,
);
assert.match(
  completeVisibleState,
  /Nothing has been entered or submitted yet\./,
);

console.log("Form draft unit tests passed.");
