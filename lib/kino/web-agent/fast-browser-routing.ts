import { normalizeNavigationTarget } from "./navigation-target.ts";

type ConnectedSiteSummary = { id: string; name: string };

export type FastBrowserCommand =
  | { tool: "web_open_site"; args: { site: string } }
  | { tool: "web_navigate"; args: { target: string } };

const POLITE_PREFIX =
  /^(?:(?:please|can you|could you|would you)\s+)*(?:open|launch)\s+/i;
const NAVIGATION_COMMAND =
  /^(?:(?:please|can you|could you|would you)\s+)*(?:open|show|go\s+to|navigate\s+to|take\s+me\s+to)\s+(?:(?:the|my)\s+)?(.+?)\s+(?:section|page|screen|area|module|tab)$/i;
const ACTION_DESTINATION =
  /\b(?:form|dialog|button|delete|remove|refund|submit|save|confirm|block|assign|cancel|logout)\b/i;

function normalizedSiteReference(value: string) {
  return value
    .trim()
    .replace(/^(?:the|my)\s+/i, "")
    .replace(/\s+(?:app|application|site|website)$/i, "")
    .trim()
    .toLowerCase();
}

export function resolveFastBrowserCommand(
  message: string,
  sites: ConnectedSiteSummary[],
): FastBrowserCommand | null {
  const compact = message.trim().replace(/\s+/g, " ");
  if (!compact || compact.length > 160 || /\b(?:and|then)\b/i.test(compact)) {
    return null;
  }

  const openTarget = compact.replace(POLITE_PREFIX, "");
  if (openTarget !== compact) {
    const requested = normalizedSiteReference(openTarget);
    const matchedSites = sites.filter(
      (site) =>
        site.id.toLowerCase() === requested ||
        site.name.toLowerCase() === requested,
    );
    if (matchedSites.length === 1) {
      return { tool: "web_open_site", args: { site: matchedSites[0].id } };
    }
  }

  const navigationMatch = compact.match(NAVIGATION_COMMAND);
  if (!navigationMatch || sites.length !== 1) return null;
  const target = normalizeNavigationTarget(navigationMatch[1]);
  if (!target || ACTION_DESTINATION.test(target)) return null;
  return { tool: "web_navigate", args: { target } };
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function formatBrowserCommandResponse(
  toolName: "web_open_site" | "web_navigate",
  toolResult: unknown,
) {
  const wrapper = record(toolResult);
  const result = record(wrapper?.result) ?? wrapper;
  if (!result) return "The browser operation could not be verified.";
  if (result.success !== true) {
    return text(result.message) || "The browser operation could not be completed.";
  }
  if (toolName === "web_open_site") {
    return text(result.message) || "The connected application is open.";
  }
  const site = record(result.site);
  const matched = text(result.matched) || text(result.requested) || "requested page";
  const siteName = text(site?.name);
  return siteName
    ? `Opened ${matched} in ${siteName}.`
    : `Opened ${matched}.`;
}
