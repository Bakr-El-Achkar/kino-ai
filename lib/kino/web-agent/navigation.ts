import type { Locator, Page } from "playwright";

import {
  BrowserSessionError,
  getBrowserSession,
} from "./browser-manager";
import { ConnectionError, getConnectedSite } from "./connections";
import {
  isAllowedOrigin,
  isAuthenticationRoute,
  safeUrlForLog,
  settleVisiblePage,
} from "./page-safety";
import {
  navigationSemanticKey,
  normalizeNavigationTarget,
} from "./navigation-target";
import type {
  NavigationFailure,
  NavigationResult,
  NavigationSiteSummary,
  ResolvedConnectedSite,
} from "./types";

const MAX_LINKS = 100;
const MAX_AVAILABLE_NAMES = 20;
const BLOCKED_ACTION_PATTERN =
  /\b(?:delete|remove|refund|submit|save|confirm|block|assign|cancel|logout)\b/i;

type LinkCandidate = {
  locator: Locator;
  name: string;
  href: string | null;
  resolvedOrigin: string | null;
  safeNavigation: boolean;
  insideNavigation: boolean;
};

export type NavigateConnectedSiteInput = {
  siteId?: string;
  target: string;
};

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
      /\b\d{1,6}\s+[\w.'-]+(?:\s+[\w.'-]+){0,4}\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|boulevard|blvd)\b/gi,
      "[REDACTED ADDRESS]",
    )
    .replace(/\b(?:bearer|token)\s+[A-Z0-9._~-]+\b/gi, "[REDACTED TOKEN]");
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
    // Fall through to safe accessibility-related attributes.
  }

  const fallback =
    (await locator.getAttribute("aria-label")) ??
    (await locator.getAttribute("title")) ??
    (await locator.getAttribute("alt")) ??
    "";
  return safeName(fallback);
}

function describeHref(rawHref: string | null, baseUrl: string) {
  if (!rawHref?.trim()) {
    return {
      href: null,
      resolvedOrigin: null,
      safeNavigation: false,
    };
  }

  if (/^(?:javascript|mailto|tel|data|file):/i.test(rawHref.trim())) {
    return {
      href: null,
      resolvedOrigin: null,
      safeNavigation: false,
    };
  }

  try {
    const resolved = new URL(rawHref, baseUrl);
    const safeNavigation = ["http:", "https:"].includes(resolved.protocol);
    const displayUrl = new URL(resolved);
    displayUrl.username = "";
    displayUrl.password = "";
    displayUrl.search = "";
    displayUrl.hash = "";

    return {
      href: displayUrl.href,
      resolvedOrigin: resolved.origin,
      safeNavigation,
    };
  } catch {
    return {
      href: null,
      resolvedOrigin: null,
      safeNavigation: false,
    };
  }
}

async function collectVisibleLinks(page: Page) {
  const links: LinkCandidate[] = [];
  const seen = new Set<string>();
  const locators = page.getByRole("link");
  const count = await locators.count();

  for (let index = 0; index < count && links.length < MAX_LINKS; index += 1) {
    const locator = locators.nth(index);

    try {
      if (!(await locator.isVisible())) continue;
      const location = await locator.evaluate((element) => ({
        insideNavigation: Boolean(element.closest('nav, [role="navigation"]')),
        insideRecordCollection: Boolean(
          element.closest('table, [role="table"], [role="grid"], [role="row"]'),
        ),
      }));
      if (location.insideRecordCollection) continue;

      const name = await getAccessibleName(locator);
      if (!name) continue;

      const href = describeHref(await locator.getAttribute("href"), page.url());
      const key = `${normalize(name).toLowerCase()}|${href.href ?? ""}`;
      if (seen.has(key)) continue;

      seen.add(key);
      links.push({
        locator,
        name,
        ...href,
        insideNavigation: location.insideNavigation,
      });
    } catch {
      // Ignore links that detach while the application settles.
    }
  }

  return links;
}

function matchRank(name: string, target: string) {
  const candidate = normalize(name).toLowerCase();
  const requested = normalizeNavigationTarget(target).toLowerCase();
  if (candidate === requested) return 1;
  if (navigationSemanticKey(candidate) === navigationSemanticKey(requested)) return 2;
  if (candidate.startsWith(requested)) return 3;
  if (candidate.includes(requested)) return 4;
  return null;
}

function findBestMatches(
  links: LinkCandidate[],
  target: string,
  allowedOrigin: string,
) {
  const ranked = links
    .map((link) => ({ link, rank: matchRank(link.name, target) }))
    .filter(
      (candidate): candidate is { link: LinkCandidate; rank: number } =>
        candidate.rank !== null,
    );
  if (ranked.length === 0) return [];

  const bestRank = Math.min(...ranked.map(({ rank }) => rank));
  let best = ranked
    .filter(({ rank }) => rank === bestRank)
    .map(({ link }) => link);

  const sameOrigin = best.filter(
    (link) => link.resolvedOrigin === allowedOrigin,
  );
  if (sameOrigin.length > 0) best = sameOrigin;

  const insideNavigation = best.filter((link) => link.insideNavigation);
  if (insideNavigation.length > 0) best = insideNavigation;
  return best;
}

function availableNavigation(links: LinkCandidate[]) {
  return [...new Set(links.map(({ name }) => name))].slice(
    0,
    MAX_AVAILABLE_NAMES,
  );
}

function siteSummary(site: ResolvedConnectedSite): NavigationSiteSummary {
  return { id: site.id, name: site.name };
}

function failure(
  result: Omit<NavigationFailure, "success">,
): NavigationFailure {
  return { success: false, ...result };
}

function connectionFailure(
  error: ConnectionError,
  requested: string,
): NavigationFailure {
  return failure({
    code: error.code,
    message: error.message,
    requested,
    availableNavigation: error.availableSites?.map(
      ({ id, name }) => `${name} (${id})`,
    ),
  });
}

export async function navigateConnectedSite({
  siteId,
  target,
}: NavigateConnectedSiteInput): Promise<NavigationResult> {
  const requested = normalizeNavigationTarget(target);
  if (!requested || requested.length > 120) {
    return failure({
      code: "INVALID_ARGUMENTS",
      message: "A concise semantic destination is required.",
    });
  }

  let site: ResolvedConnectedSite;
  try {
    site = await getConnectedSite(siteId);
  } catch (error) {
    if (error instanceof ConnectionError) return connectionFailure(error, requested);
    throw error;
  }

  const summary = siteSummary(site);

  try {
    const session = await getBrowserSession(site);
    const { page } = session;

    console.log(
      `Web Agent: ${session.reused ? "Reusing" : "Opened"} visible browser session for ${site.name}.`,
    );
    await settleVisiblePage(page);

    const currentUrl = page.url();
    if (isAuthenticationRoute(currentUrl)) {
      return failure({
        code: "AUTH_EXPIRED",
        message: "The saved website session has expired. Reconnect the website.",
        requested,
        site: summary,
      });
    }
    if (!isAllowedOrigin(currentUrl, site.allowedOrigin)) {
      return failure({
        code: "UNEXPECTED_ORIGIN",
        message: "The connected browser is not on its allowed website origin.",
        requested,
        site: summary,
      });
    }

    const links = await collectVisibleLinks(page);
    const matches = findBestMatches(links, requested, site.allowedOrigin);
    const safeAvailableNavigation = availableNavigation(links);

    if (matches.length === 0) {
      return failure({
        code: "NO_MATCH",
        message: `No matching navigation link was found for ${JSON.stringify(requested)}.`,
        requested,
        site: summary,
        availableNavigation: safeAvailableNavigation,
      });
    }
    if (matches.length > 1) {
      return failure({
        code: "AMBIGUOUS_MATCH",
        message: "Multiple equally strong navigation matches were found.",
        requested,
        site: summary,
        candidates: [...new Set(matches.map(({ name }) => name))],
      });
    }

    const [match] = matches;
    if (BLOCKED_ACTION_PATTERN.test(match.name)) {
      return failure({
        code: "UNSAFE_NAVIGATION_BLOCKED",
        message: `The matched link ${JSON.stringify(match.name)} is an action and was not activated.`,
        requested,
        site: summary,
      });
    }
    if (!match.safeNavigation || !match.href) {
      return failure({
        code: "UNSAFE_NAVIGATION_BLOCKED",
        message: "The matched link is not a normal HTTP(S) navigation link.",
        requested,
        site: summary,
      });
    }
    if (match.resolvedOrigin !== site.allowedOrigin) {
      return failure({
        code: "EXTERNAL_NAVIGATION_BLOCKED",
        message: "The matched link leaves the connected website and was not activated.",
        requested,
        site: summary,
      });
    }

    const previousUrl = page.url();
    console.log(`Web Agent: Matched semantic link ${JSON.stringify(match.name)}.`);

    const urlChange = page
      .waitForURL((url) => url.href !== previousUrl, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    await match.locator.click({ timeout: 15_000 });
    const urlChanged = await urlChange;
    await page
      .waitForLoadState("domcontentloaded", { timeout: 10_000 })
      .catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    const finalUrl = page.url();
    if (isAuthenticationRoute(finalUrl)) {
      return failure({
        code: "AUTH_EXPIRED",
        message: "The saved website session has expired. Reconnect the website.",
        requested,
        site: summary,
      });
    }
    if (!isAllowedOrigin(finalUrl, site.allowedOrigin)) {
      return failure({
        code: "EXTERNAL_NAVIGATION_BLOCKED",
        message: "Navigation left the connected website's allowed origin.",
        requested,
        site: summary,
      });
    }
    if (!urlChanged || finalUrl === previousUrl) {
      return failure({
        code: "NO_URL_CHANGE",
        message: "The semantic link was activated, but the page URL did not change.",
        requested,
        site: summary,
      });
    }

    console.log("Web Agent: Navigation successful.");
    return {
      success: true,
      site: summary,
      requested,
      matched: match.name,
      previousUrl: safeUrlForLog(previousUrl),
      finalUrl: safeUrlForLog(finalUrl),
      pageTitle: await page.title(),
      authentication: "ACTIVE",
      visibleNavigationLinks: links.length,
      browserReused: session.reused,
    };
  } catch (error) {
    if (error instanceof BrowserSessionError) {
      return failure({
        code: error.code,
        message: error.message,
        requested,
        site: summary,
      });
    }

    console.error(
      "Web Agent navigation error:",
      error instanceof Error ? error.message : "Unknown browser error.",
    );
    return failure({
      code: "BROWSER_ERROR",
      message: "The connected website could not be navigated.",
      requested,
      site: summary,
    });
  }
}
