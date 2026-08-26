import type { BrowserObservation } from "./types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function unwrapToolResult(value: unknown) {
  const wrapper = record(value);
  return record(wrapper?.result) ?? wrapper;
}

export function formatObservation(observation: BrowserObservation) {
  const lines = [`${observation.title || "Untitled page"} — ${observation.url}`];
  if (observation.status === "AUTH_REQUIRED") {
    lines.push("Authentication is required. Use the secure login fields below; do not type credentials into chat.");
  } else if (observation.status === "CAPTCHA_REQUIRED") {
    lines.push("A CAPTCHA or human-verification challenge is visible. Human intervention is required.");
  } else if (observation.status === "MFA_REQUIRED") {
    lines.push("A multi-factor authentication challenge is visible. Human intervention is required.");
  }
  if (observation.visibleText.length) {
    lines.push(observation.visibleText.slice(0, 8).join(" · "));
  }
  if (observation.elements.length) {
    lines.push(
      `Visible controls: ${observation.elements.slice(0, 12).map((element) => `${element.name} (${element.role})`).join(", ")}`,
    );
  }
  return lines.join("\n\n");
}

export function formatBrowserToolResponse(toolResult: unknown) {
  const result = unwrapToolResult(toolResult);
  if (!result) return "The browser operation could not be verified.";
  if (result.status === "ACTION_UNVERIFIED") {
    return text(result.message) || "The control was activated, but completion could not be strongly verified.";
  }
  const observation = record(result.observation) as BrowserObservation | null;
  if (observation) {
    const formatted = formatObservation(observation);
    return result.status === "OPENED" ? `Opened in KINO Browser.\n\n${formatted}` : formatted;
  }
  return text(result.message) || "The browser operation completed without a verifiable page observation.";
}
