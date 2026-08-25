import type {
  WebActionDestination,
  WebActionRisk,
  WebActionRole,
} from "./action-types";

const CRITICAL_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\s+(?:permanently|account|user|customer|record|data)\b/i,
  /\brefund\b/i,
  /\b(?:block|disable)\s+(?:account|user|customer)\b/i,
  /\brevoke\b/i,
  /\breset\s+(?:permissions?|security|password|credentials?)\b/i,
  /\b(?:transfer|withdraw|payout|payment)\b/i,
  /\bcancel\s+(?:transaction|order|payment|subscription|booking)\b/i,
  /\b(?:erase|purge|destroy)\b/i,
];

const WRITE_PATTERN =
  /\b(?:add|create|edit|update|save|assign|reschedule|upload|send|submit|change\s+status|approve|reject|publish|invite|archive|restore|enable|confirm)\b/i;

const READ_PATTERN =
  /\b(?:open|view|show|search|filter|expand|collapse|previous|prev|next|sort|details?|dashboard|list|browse|go\s+to|navigate)\b/i;

export type ClassifyActionRiskInput = {
  name: string;
  role: WebActionRole;
  destination?: WebActionDestination;
};

export function classifyActionRisk({
  name,
  role,
  destination = "none",
}: ClassifyActionRiskInput): { risk: WebActionRisk; reason: string } {
  if (CRITICAL_PATTERNS.some((pattern) => pattern.test(name))) {
    return {
      risk: "critical",
      reason: "The control describes a destructive, security-sensitive, or financial action.",
    };
  }

  if (WRITE_PATTERN.test(name)) {
    return {
      risk: "write",
      reason: "The control likely creates or modifies application data.",
    };
  }

  if (role === "tab") {
    return { risk: "read", reason: "The control changes the visible page section." };
  }

  if (
    role === "link" &&
    (destination === "same-origin" || destination === "same-page")
  ) {
    return { risk: "read", reason: "The control performs same-site navigation." };
  }

  if (READ_PATTERN.test(name)) {
    return { risk: "read", reason: "The control describes a read-only interface action." };
  }

  if (role === "checkbox" || role === "radio" || role === "switch") {
    return {
      risk: "write",
      reason: "Changing this control may modify application state.",
    };
  }

  return {
    risk: "write",
    reason: "The control's effect is uncertain, so it is conservatively treated as a write.",
  };
}
