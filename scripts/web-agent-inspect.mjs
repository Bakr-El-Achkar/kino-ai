import { chromium } from "playwright";
import { access, mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SESSION_PATH = ".kino/sessions/cleannest.json";
const INSPECTION_DIRECTORY = ".kino/inspections";
const INSPECTION_PATH = `${INSPECTION_DIRECTORY}/cleannest-dashboard.json`;
const DASHBOARD_URL =
  "https://cleannest-platform-two.vercel.app/admin/dashboard";
const MAX_ELEMENTS = 100;
const MAX_SNAPSHOT_LENGTH = 6_000;
const ROLES = [
  "link",
  "button",
  "heading",
  "textbox",
  "combobox",
  "checkbox",
  "tab",
  "menuitem",
];
const SNAPSHOT_ROLES = new Set([
  "application",
  "banner",
  "button",
  "checkbox",
  "combobox",
  "complementary",
  "contentinfo",
  "document",
  "form",
  "heading",
  "img",
  "link",
  "list",
  "listitem",
  "main",
  "menu",
  "menuitem",
  "navigation",
  "region",
  "search",
  "status",
  "tab",
  "tablist",
  "textbox",
]);

let browser;
let context;
let page;

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
  const redacted = redactSensitiveText(value.replace(/\s+/g, " ")).trim();
  return redacted.length > 120 ? `${redacted.slice(0, 117)}...` : redacted;
}

function sanitizeHref(rawHref, baseUrl) {
  if (!rawHref) return {};

  try {
    const resolved = new URL(rawHref, baseUrl);
    const base = new URL(baseUrl);
    const sameOrigin = resolved.origin === base.origin;
    const safeSegments = resolved.pathname.split("/").map((segment) => {
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
      if (/^\d{5,}$/.test(segment)) return ":id";
      return segment;
    });

    resolved.username = "";
    resolved.password = "";
    resolved.pathname = safeSegments.join("/");
    resolved.search = "";
    resolved.hash = "";

    return { href: resolved.href, sameOrigin };
  } catch {
    return {};
  }
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
    // Fall through to safe DOM labels when an individual snapshot is unavailable.
  }

  const fallback =
    (await locator.getAttribute("aria-label")) ??
    (await locator.getAttribute("title")) ??
    (await locator.getAttribute("alt")) ??
    "";
  return safeName(fallback);
}

async function isInsideRecordCollection(locator) {
  return locator.evaluate((element) =>
    Boolean(element.closest('table, [role="table"], [role="grid"], [role="row"]')),
  );
}

async function collectElements(currentPage) {
  const elements = [];
  const seen = new Set();

  for (const role of ROLES) {
    const matches = currentPage.getByRole(role);
    const count = await matches.count();

    for (let index = 0; index < count && elements.length < MAX_ELEMENTS; index += 1) {
      const locator = matches.nth(index);
      if (!(await locator.isVisible())) continue;
      if (await isInsideRecordCollection(locator)) continue;

      const name = await getAccessibleName(locator);
      const item = { role, name: name || "(unnamed)" };

      if (role === "link") {
        Object.assign(
          item,
          sanitizeHref(await locator.getAttribute("href"), currentPage.url()),
        );
      }

      const key = `${item.role}|${item.name}|${item.href ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      elements.push(item);
    }

    if (elements.length >= MAX_ELEMENTS) break;
  }

  return elements;
}

function sanitizeAriaSnapshot(snapshot) {
  const safeLines = [];
  let omittedIndent = null;

  for (const rawLine of snapshot.split("\n")) {
    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;

    if (omittedIndent !== null) {
      if (rawLine.trim() && indent > omittedIndent) continue;
      omittedIndent = null;
    }

    const roleMatch = rawLine.match(/^\s*-\s+([a-z][\w-]*)\b/i);
    if (!roleMatch) continue;

    const role = roleMatch[1].toLowerCase();
    if (["table", "grid", "rowgroup", "row", "cell", "gridcell"].includes(role)) {
      safeLines.push(`${" ".repeat(indent)}- ${role}: [record contents omitted]`);
      omittedIndent = indent;
      continue;
    }

    if (!SNAPSHOT_ROLES.has(role)) continue;

    let safeLine = redactSensitiveText(rawLine);
    if (["list", "listitem", "form", "region"].includes(role)) {
      safeLine = safeLine.replace(/"(?:\\.|[^"\\])*"/, '"[name omitted]"');
    }
    safeLines.push(safeLine.slice(0, 240));
  }

  const sanitized = safeLines.join("\n");
  if (sanitized.length <= MAX_SNAPSHOT_LENGTH) {
    return { preview: sanitized, truncated: false };
  }

  return {
    preview: `${sanitized.slice(0, MAX_SNAPSHOT_LENGTH)}\n... [snapshot truncated]`,
    truncated: true,
  };
}

function printGroup(label, elements) {
  console.log(`\n${label}:`);
  if (elements.length === 0) {
    console.log("- None found");
    return;
  }

  for (const element of elements) {
    if (element.role === "link") {
      console.log(`- ${element.name} -> ${element.href ?? "(no href)"}`);
    } else {
      console.log(`- ${element.name}`);
    }
  }
}

console.log("KINO Web Inspector");

try {
  try {
    await access(SESSION_PATH);
  } catch {
    console.error("No saved CleanNest session found.");
    console.error("Run:");
    console.error("npm run web-agent:connect");
    process.exitCode = 1;
  }

  if (!process.exitCode) {
    console.log("Analyzing authenticated application...");

    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({ storageState: SESSION_PATH });
    page = await context.newPage();

    await page.goto(DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});

    const finalUrl = page.url();
    const finalPath = new URL(finalUrl).pathname.toLowerCase();
    const authenticated =
      finalPath === "/admin" || finalPath.startsWith("/admin/");

    if (!authenticated) {
      console.error("Authentication state invalid or expired.");
      console.error("Reconnect using:");
      console.error("npm run web-agent:connect");
      process.exitCode = 1;
    } else {
      const title = await page.title();
      const rawSnapshot = await page.ariaSnapshot({ mode: "ai", depth: 6 });
      const { preview: snapshotPreview, truncated } =
        sanitizeAriaSnapshot(rawSnapshot);
      const elements = await collectElements(page);
      const byRole = (role) => elements.filter((element) => element.role === role);
      const inputs = elements.filter((element) =>
        ["textbox", "combobox", "checkbox"].includes(element.role),
      );
      const otherElements = elements.filter((element) =>
        ["tab", "menuitem"].includes(element.role),
      );

      console.log("\nPage:");
      console.log(title);
      console.log("\nURL:");
      console.log(finalUrl);
      console.log("\nAuthentication:");
      console.log("ACTIVE");
      console.log("\nDiscovered structure:");
      printGroup("Headings", byRole("heading"));
      printGroup("Navigation / Links", byRole("link"));
      printGroup("Buttons", byRole("button"));
      printGroup("Inputs", inputs);
      printGroup("Other roles", otherElements);
      console.log("\nARIA Snapshot Preview:");
      console.log(snapshotPreview || "(No safe structural snapshot lines found)");
      if (truncated) console.log("Snapshot preview was truncated.");
      console.log(`\nTotal discovered elements: ${elements.length}`);

      await mkdir(INSPECTION_DIRECTORY, { recursive: true });
      await writeFile(
        INSPECTION_PATH,
        `${JSON.stringify(
          {
            url: finalUrl,
            title,
            authenticated: true,
            inspectedAt: new Date().toISOString(),
            elements,
          },
          null,
          2,
        )}\n`,
        { encoding: "utf8", mode: 0o600 },
      );

      console.log("\nInspection saved:");
      console.log(INSPECTION_PATH);
      console.log("\nBrowser is open.");

      const terminal = createInterface({ input, output });
      try {
        await terminal.question("Press ENTER to close.\n");
      } finally {
        terminal.close();
      }
    }
  }
} catch (error) {
  console.error("Web inspection failed:", error);
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
