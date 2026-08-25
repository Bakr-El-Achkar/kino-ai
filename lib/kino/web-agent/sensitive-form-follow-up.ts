import { isExplicitCancellation, parseActionConfirmation } from "./action-confirmation.ts";
import { getSensitiveFormFillRequest } from "./ephemeral-secrets.ts";

export function requestedSensitiveField(message: string) {
  const normalized = message
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized || normalized.length > 180 || !/\b(?:fill|enter|populate|type)\b/.test(normalized)) {
    return null;
  }
  if (/\bpassword\b/.test(normalized)) return "Password";
  if (/\bpasscode\b/.test(normalized)) return "Passcode";
  if (/\bpin\b/.test(normalized)) return "PIN";
  if (/\b(?:remaining|sensitive)\s+(?:field|value)\b/.test(normalized)) return "";
  return null;
}

export function getSensitiveFormFillFollowUpTool(
  conversationId: string,
  latestUserMessage: string,
  now = new Date(),
) {
  const lookup = getSensitiveFormFillRequest(conversationId, undefined, now);
  if (lookup.status !== "FOUND") return null;
  const { stage } = lookup.request;
  if (
    ["awaiting_secure_value", "awaiting_confirmation", "executing"].includes(stage) &&
    isExplicitCancellation(latestUserMessage)
  ) {
    return "web_cancel_sensitive_form_fill" as const;
  }
  const confirmation = parseActionConfirmation({
    message: latestUserMessage,
    risk: "write",
  });
  if (stage === "awaiting_confirmation" && confirmation.explicit) {
    return "web_execute_sensitive_form_fill" as const;
  }
  if (stage === "executed" && confirmation.explicit) {
    return "web_execute_sensitive_form_fill" as const;
  }
  return null;
}
