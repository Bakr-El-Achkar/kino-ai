import type { Locator, Page } from "playwright";

import { classifyActionRisk } from "./action-risk";
import type {
  WebActionCandidate,
  WebActionDestination,
  WebActionRole,
} from "./action-types";

const MAX_ACTION_CANDIDATES = 50;
const MAX_LIVE_ACTIONS = 100;
const MAX_ROLE_SCAN = 100;
const ACTION_ROLES: WebActionRole[] = [
  "button",
  "link",
  "menuitem",
  "checkbox",
  "radio",
  "switch",
  "tab",
];

function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function redactSensitiveText(value: string) {
  return value
    .replace(
      /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
      "[REDACTED EMAIL]",
    )
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[REDACTED PHONE/NUMBER]")
    .replace(
      /\b(?:bearer|token|password|secret)\s*[:=]?\s*[A-Z0-9._~-]+\b/gi,
      "[REDACTED SENSITIVE VALUE]",
    );
}

function safeName(value: string) {
  const redacted = redactSensitiveText(normalize(value));
  return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
}

function nameFromAriaSnapshot(snapshot: string) {
  const match = snapshot.match(
    /^\s*-\s+[a-z][\w-]*(?:\s+"((?:\\.|[^"\\])*)")?/im,
  );
  if (!match?.[1]) return "";

  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1].replaceAll('\\"', '"');
  }
}

async function getAccessibleName(locator: Locator) {
  try {
    const snapshot = await locator.ariaSnapshot({ mode: "ai", depth: 0 });
    const name = nameFromAriaSnapshot(snapshot);
    if (name) return safeName(name);
  } catch {
    // Fall through to accessibility-related attributes only.
  }

  const fallback =
    (await locator.getAttribute("aria-label")) ??
    (await locator.getAttribute("title")) ??
    (await locator.getAttribute("alt")) ??
    "";
  return safeName(fallback);
}

function describeLinkDestination(
  rawHref: string | null,
  currentUrl: string,
): WebActionDestination {
  if (!rawHref?.trim()) return "none";
  if (/^(?:javascript|mailto|tel|data|file):/i.test(rawHref.trim())) return "unsafe";

  try {
    const destination = new URL(rawHref, currentUrl);
    const current = new URL(currentUrl);
    if (!["http:", "https:"].includes(destination.protocol)) return "unsafe";
    if (destination.origin !== current.origin) return "external";
    if (
      destination.pathname === current.pathname &&
      destination.search === current.search
    ) {
      return "same-page";
    }
    return "same-origin";
  } catch {
    return "unsafe";
  }
}

export async function discoverWebActions(page: Page): Promise<WebActionCandidate[]> {
  const liveActions = await discoverLiveWebActions(page);
  const candidates: WebActionCandidate[] = [];
  const seen = new Set<string>();

  for (const { candidate } of liveActions) {
    const key = `${candidate.role}|${candidate.name.toLowerCase()}|${candidate.destination}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(candidate);
    if (candidates.length >= MAX_ACTION_CANDIDATES) break;
  }
  return candidates;
}

export type LiveWebAction = {
  candidate: WebActionCandidate;
  locator: Locator;
};

export async function discoverLiveWebActions(page: Page): Promise<LiveWebAction[]> {
  const actions: LiveWebAction[] = [];

  for (const role of ACTION_ROLES) {
    const roleLocators = page.getByRole(role);
    const count = Math.min(await roleLocators.count(), MAX_ROLE_SCAN);

    for (let index = 0; index < count; index += 1) {
      if (actions.length >= MAX_LIVE_ACTIONS) return actions;
      const locator = roleLocators.nth(index);

      try {
        if (!(await locator.isVisible())) continue;
        const insidePrivateRecordCollection = await locator.evaluate((element) =>
          Boolean(element.closest('table, [role="table"], [role="grid"], [role="row"]')),
        );
        if (insidePrivateRecordCollection) continue;

        const name = await getAccessibleName(locator);
        if (!name) continue;
        const destination =
          role === "link"
            ? describeLinkDestination(await locator.getAttribute("href"), page.url())
            : "none";
        const classification = classifyActionRisk({ name, role, destination });
        actions.push({
          locator,
          candidate: {
            id: `action-${actions.length + 1}`,
            role,
            name,
            destination,
            ...classification,
          },
        });
      } catch {
        // Ignore controls that detach while the application settles.
      }
    }
  }

  return actions;
}
