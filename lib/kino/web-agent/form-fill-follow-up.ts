import { isExplicitCancellation, parseActionConfirmation } from "./action-confirmation.ts";
import {
  getLatestScopedFormFill,
  getScopedPendingFormFill,
} from "./pending-form-fills.ts";

export function looksLikeFormFillRequest(message: string) {
  const normalized = message
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized || normalized.length > 180) return false;
  return (
    /^(?:please )?fill (?:the |this |these |my )?(?:prepared )?(?:values )?(?:into )?(?:the )?form$/.test(normalized) ||
    /^(?:please )?(?:put|enter|populate) (?:the |these )?prepared values (?:into|in) (?:the )?form$/.test(normalized) ||
    /^(?:please )?fill these values$/.test(normalized)
  );
}

export function getPendingFormFillFollowUpTool(
  conversationId: string,
  latestUserMessage: string,
  now = new Date(),
) {
  const pending = getScopedPendingFormFill(conversationId, undefined, now);
  if (pending.status !== "FOUND") {
    const latest = getLatestScopedFormFill(conversationId, now);
    const confirmation = parseActionConfirmation({
      message: latestUserMessage,
      risk: "write",
    });
    return latest &&
      latest.status === "executed" &&
      confirmation.explicit
      ? ("web_execute_form_fill" as const)
      : null;
  }
  if (isExplicitCancellation(latestUserMessage)) {
    return "web_cancel_form_fill" as const;
  }
  const confirmation = parseActionConfirmation({
    message: latestUserMessage,
    risk: "write",
  });
  return confirmation.explicit ? ("web_execute_form_fill" as const) : null;
}
