import { chromium } from "playwright";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SESSION_PATH = ".kino/sessions/cleannest.json";
const START_URL = "https://cleannest-platform-two.vercel.app/admin/dashboard";
const MAX_LINKS = 100;
const MAX_AVAILABLE_NAMES = 20;
const BLOCKED_ACTION_PATTERN =
  /\b(?:delete|remove|refund|submit|save|confirm|block|assign|cancel|logout)\b/i;

let browser;
let context;
let page;

function normalize(value) {
  return value.trim().replace(/\s+/g, " ");
}

function redactSensitiveText(value) {
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

function safeName(value) {
  const redacted = redactSensitiveText(normalize(value));
  return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
}

function nameFromAriaSnapshot(snapshot) {
  const match = snapshot.match(
    /^\s*-\s+[a-z][\w-]*(?:\s+"((?:\\.|[^"\\])*)")?/im,
  );
  if (!match?.[1]) return "";

  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1].replaceAll('\\"', '"');
  }
}

async function getAccessibleName(locator) {
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

function describeHref(rawHref, baseUrl) {
  if (!rawHref?.trim()) {
    return { href: null, sameOrigin: false, safeNavigation: false };
  }

  const trimmedHref = rawHref.trim();
  if (/^(?:javascript|mailto|tel|data):/i.test(trimmedHref)) {
    return { href: trimmedHref.split(":", 1)[0] + ":", sameOrigin: false, safeNavigation: false };
  }

  try {
    const resolved = new URL(trimmedHref, baseUrl);
    const base = new URL(baseUrl);
    const safeNavigation = ["http:", "https:"].includes(resolved.protocol);
    const sameOrigin = resolved.origin === base.origin;
    const displayUrl = new URL(resolved);

    displayUrl.username = "";
    displayUrl.password = "";
    displayUrl.search = "";
    displayUrl.hash = "";

    return {
      href: displayUrl.href,
      sameOrigin,
      safeNavigation,
    };
  } catch {
    return { href: null, sameOrigin: false, safeNavigation: false };
  }
}

async function collectVisibleLinks(currentPage) {
  const links = [];
  const seen = new Set();
  const locators = currentPage.getByRole("link");
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

      const href = describeHref(
        await locator.getAttribute("href"),
        currentPage.url(),
      );
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
      // Ignore links that detach while the SPA is settling.
    }
  }

  return links;
}

function matchRank(name, target) {
  const candidate = normalize(name);
  const requested = normalize(target);
  const candidateLower = candidate.toLowerCase();
  const requestedLower = requested.toLowerCase();

  if (candidate === requested) return 1;
  if (candidateLower === requestedLower) return 2;
  if (candidateLower.startsWith(requestedLower)) return 3;
  if (candidateLower.includes(requestedLower)) return 4;
  return null;
}

function findBestMatches(links, target) {
  const ranked = links
    .map((link) => ({ link, rank: matchRank(link.name, target) }))
    .filter((candidate) => candidate.rank !== null);

  if (ranked.length === 0) return [];

  const bestRank = Math.min(...ranked.map((candidate) => candidate.rank));
  let best = ranked
    .filter((candidate) => candidate.rank === bestRank)
    .map((candidate) => candidate.link);

  const sameOrigin = best.filter((link) => link.sameOrigin);
  if (sameOrigin.length > 0) best = sameOrigin;

  const insideNavigation = best.filter((link) => link.insideNavigation);
  if (insideNavigation.length > 0) best = insideNavigation;

  return best;
}

function printAvailableLinks(links) {
  const names = [...new Set(links.map((link) => link.name))].slice(
    0,
    MAX_AVAILABLE_NAMES,
  );

  console.log("\nAvailable navigation:");
  if (names.length === 0) {
    console.log("- No safely named links found");
    return;
  }

  for (const name of names) console.log(`- ${name}`);
}

function isLoginRoute(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  return /\/(?:login|sign-in|signin)(?:\/|$)/.test(pathname);
}

async function waitForTerminal() {
  console.log("\nBrowser is open.");
  const terminal = createInterface({ input, output });
  try {
    await terminal.question("Press ENTER to close.\n");
  } finally {
    terminal.close();
  }
}

const requestedTarget = normalize(process.argv.slice(2).join(" "));

if (!requestedTarget) {
  console.error("Usage:");
  console.error('npm run web-agent:navigate -- "Page Name"');
  process.exitCode = 1;
} else {
  try {
    try {
      await access(SESSION_PATH);
    } catch {
      console.error("No saved CleanNest session found.");
      console.error("\nRun:");
      console.error("npm run web-agent:connect");
      process.exitCode = 1;
    }

    if (!process.exitCode) {
      browser = await chromium.launch({ headless: false });
      context = await browser.newContext({ storageState: SESSION_PATH });
      page = await context.newPage();

      await page.goto(START_URL, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

      if (isLoginRoute(page.url())) {
        console.error("Authentication state invalid or expired.");
        console.error("Reconnect using:");
        console.error("npm run web-agent:connect");
        process.exitCode = 1;
      } else {
        const links = await collectVisibleLinks(page);
        const matches = findBestMatches(links, requestedTarget);

        console.log(`Visible navigation links discovered: ${links.length}`);

        if (matches.length === 0) {
          console.error("\nNo matching navigation link found for:");
          console.error(JSON.stringify(requestedTarget));
          printAvailableLinks(links);
          process.exitCode = 1;
        } else if (matches.length > 1) {
          console.error("\nMultiple navigation matches found:");
          for (const match of matches) console.error(`- ${match.name}`);
          console.error("\nPlease use a more specific target.");
          process.exitCode = 1;
        } else {
          const [match] = matches;

          if (BLOCKED_ACTION_PATTERN.test(match.name)) {
            console.error(`\nRefusing unsafe navigation link: ${match.name}`);
            process.exitCode = 1;
          } else if (!match.safeNavigation || !match.href) {
            console.error("\nMatched link is not a normal safe web navigation link.");
            process.exitCode = 1;
          } else if (!match.sameOrigin) {
            console.error("\nMatched link is external. Navigation stopped safely.");
            process.exitCode = 1;
          } else {
            const previousUrl = page.url();

            console.log("\nKINO Web Navigation");
            console.log("Requested destination:");
            console.log(requestedTarget);
            console.log("\nMatched:");
            console.log(match.name);
            console.log("\nNavigating...");

            const urlChange = page
              .waitForURL((url) => url.href !== previousUrl, { timeout: 15_000 })
              .then(() => true)
              .catch(() => false);

            await match.locator.click({ timeout: 15_000 });
            const urlChanged = await urlChange;
            await page
              .waitForLoadState("domcontentloaded", { timeout: 10_000 })
              .catch(() => {});
            await page
              .waitForLoadState("networkidle", { timeout: 5_000 })
              .catch(() => {});

            const finalUrl = page.url();
            const title = await page.title();
            const authenticationActive = !isLoginRoute(finalUrl);

            if (urlChanged) {
              console.log("\nNavigation successful.");
            } else {
              console.log("\nNavigation did not change the URL.");
            }

            console.log("\nPrevious URL:");
            console.log(previousUrl);
            console.log("\nFinal URL:");
            console.log(finalUrl);
            console.log("\nPage title:");
            console.log(title);
            console.log("\nRequested:");
            console.log(requestedTarget);
            console.log("\nMatched:");
            console.log(match.name);
            console.log("\nAuthentication:");
            console.log(authenticationActive ? "ACTIVE" : "INVALID OR EXPIRED");

            if (!authenticationActive) process.exitCode = 1;
            await waitForTerminal();
          }
        }
      }
    }
  } catch (error) {
    console.error("Web navigation failed:", error);
    process.exitCode = 1;
  } finally {
    try {
      if (page && !page.isClosed()) await page.close();
    } finally {
      try {
        if (context) await context.close();
      } finally {
        if (browser) await browser.close();
      }
    }
  }
}
