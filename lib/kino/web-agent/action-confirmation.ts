import type { WebActionRisk } from "./action-types";

const STANDARD_CONFIRMATIONS = new Set([
  "yes",
  "yes continue",
  "yes proceed",
  "continue",
  "confirm",
  "confirmed",
  "confirm it",
  "confirm this",
  "confirm this process",
  "confirm the action",
  "i confirm",
  "i confirm it",
  "i confirm this",
  "i confirm this process",
  "i confirm the action",
  "proceed",
  "do it",
  "go ahead",
  "fill it",
  "yes fill it",
  "confirm and fill",
  "confirm and fill it",
  "continue with it",
  "continue the process",
  "نعم",
  "نعم اكمل",
  "اكمل",
  "تابع",
  "اكد",
  "اوكد",
  "تاكيد",
  "اكد العملية",
  "اوكد العملية",
  "نفذ",
  "تابع العملية",
]);

const CANCELLATIONS = new Set([
  "no",
  "no cancel",
  "cancel",
  "dont continue",
  "do not continue",
  "never mind",
  "nevermind",
  "stop",
  "not yet",
  "dont",
  "dont fill it",
  "do not fill it",
  "لا",
  "لا تكمل",
  "لا تتابع",
  "الغاء",
  "الغي",
  "توقف",
]);

const SAFE_CRITICAL_WORDS = new Set([
  "delete",
  "remove",
  "refund",
  "cancel",
  "block",
  "disable",
  "revoke",
  "reset",
  "transfer",
  "payment",
  "transaction",
  "order",
  "account",
  "user",
  "customer",
  "permissions",
  "security",
  "access",
]);

const COMBINED_WRITE_CONFIRMATION =
  /^(?:yes|confirmed|confirm|i confirm(?: it| this| this process| the action)?)(?:\s+(?:so|and|then))?\s+(?:continue|proceed|go ahead|do it|fill(?:\s+(?:it|this|the form))?|open(?:\s+(?:it|this|the form|(?:the\s+)?(?:[\p{L}\p{N}]+\s+){0,7}form))?)(?:\s+and\s+(?:tell|show)\s+me(?:\s+what\s+you\s+can\s+see)?)?$/u;

export function normalizeConfirmation(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
    .toLowerCase()
    .replace(/[أإآ]/g, "ا")
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isExplicitCancellation(message: string) {
  const normalized = normalizeConfirmation(message);
  return normalized.length <= 80 && CANCELLATIONS.has(normalized);
}

export function requestsPostConfirmationInspection(message: string) {
  const normalized = normalizeConfirmation(message);
  return /\b(?:tell|show) me what (?:you can )?see\b/.test(normalized);
}

function hasNegation(message: string) {
  const normalized = ` ${normalizeConfirmation(message)} `;
  return [
    " no ",
    " dont ",
    " do not ",
    " never ",
    " not ",
    " cancel ",
    " stop ",
    " لا ",
    " الغاء ",
    " الغي ",
    " توقف ",
  ].some((term) => normalized.includes(term));
}

export function buildCriticalConfirmationPhrase(actionName: string) {
  const safeWords = normalizeConfirmation(actionName)
    .split(" ")
    .filter((word) => SAFE_CRITICAL_WORDS.has(word))
    .slice(0, 4);
  return `CONFIRM ${safeWords.join(" ").toUpperCase() || "CRITICAL ACTION"}`;
}

export type ConfirmationResult =
  | { explicit: true; kind: "standard" | "strong" }
  | {
      explicit: false;
      reason:
        | "CONFIRMATION_NOT_EXPLICIT"
        | "CONFIRMATION_NEGATED"
        | "STRONG_CONFIRMATION_REQUIRED";
    };

export function parseActionConfirmation({
  message,
  risk,
  requiredPhrase,
}: {
  message: string;
  risk: Extract<WebActionRisk, "write" | "critical">;
  requiredPhrase?: string;
}): ConfirmationResult {
  const normalized = normalizeConfirmation(message);
  if (
    risk === "critical" &&
    requiredPhrase &&
    normalized === normalizeConfirmation(requiredPhrase)
  ) {
    return { explicit: true, kind: "strong" };
  }
  if (hasNegation(message)) {
    return { explicit: false, reason: "CONFIRMATION_NEGATED" };
  }

  if (risk === "critical") {
    return { explicit: false, reason: "STRONG_CONFIRMATION_REQUIRED" };
  }

  if (
    normalized.length <= 160 &&
    (STANDARD_CONFIRMATIONS.has(normalized) ||
      COMBINED_WRITE_CONFIRMATION.test(normalized))
  ) {
    return { explicit: true, kind: "standard" };
  }
  return { explicit: false, reason: "CONFIRMATION_NOT_EXPLICIT" };
}
