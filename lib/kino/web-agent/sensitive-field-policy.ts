import { isSensitiveFormField, normalizeFormFieldName } from "./form-matcher.ts";
import type { WebFormField } from "./form-types";

const AUTHENTICATION_SECRET_PATTERNS = [
  /\bpassword\b/,
  /\bpasscode\b/,
  /\bpin\b/,
];

const BLOCKED_SENSITIVE_PATTERNS = [
  /\b(?:credit|debit|payment)\s+card\b/,
  /\bcard\s+number\b/,
  /\b(?:cvv|cvc)\b/,
  /\b(?:bank|financial)\s+account\b/,
  /\b(?:routing|swift)\s+(?:number|code)\b/,
  /\biban\b/,
  /\b(?:government|national|tax)\s+id\b/,
  /\b(?:ssn|passport)\b/,
  /\b(?:authentication|auth|access)\s+token\b/,
  /\bapi\s+key\b/,
  /\b(?:client|private|secret)\s+(?:secret|key)\b/,
];

const ELIGIBLE_FIELD_TYPES = new Set(["password", "text", "tel", "number"]);

export type SensitiveFillEligibility =
  | { eligible: true; category: "authentication_secret" }
  | {
      eligible: false;
      reason: "NOT_SENSITIVE" | "BLOCKED_CATEGORY" | "UNSUPPORTED_FIELD_TYPE" | "UNSUPPORTED_SENSITIVE_CATEGORY";
    };

export function classifySensitiveFillEligibility(
  field: Pick<WebFormField, "name" | "fieldType" | "controlKind">,
): SensitiveFillEligibility {
  if (!isSensitiveFormField(field)) {
    return { eligible: false, reason: "NOT_SENSITIVE" };
  }
  const normalized = normalizeFormFieldName(field.name);
  if (BLOCKED_SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { eligible: false, reason: "BLOCKED_CATEGORY" };
  }
  if (!AUTHENTICATION_SECRET_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { eligible: false, reason: "UNSUPPORTED_SENSITIVE_CATEGORY" };
  }
  if (
    !ELIGIBLE_FIELD_TYPES.has(field.fieldType) ||
    (field.controlKind !== undefined && field.controlKind !== "input")
  ) {
    return { eligible: false, reason: "UNSUPPORTED_FIELD_TYPE" };
  }
  return { eligible: true, category: "authentication_secret" };
}
