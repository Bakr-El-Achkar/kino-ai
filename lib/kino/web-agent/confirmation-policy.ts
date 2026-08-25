import type { WebActionRisk } from "./action-types";

export function requiresConfirmation(
  risk: WebActionRisk,
): risk is Exclude<WebActionRisk, "read"> {
  return risk === "write" || risk === "critical";
}
