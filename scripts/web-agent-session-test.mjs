import { chromium } from "playwright";
import { access } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SESSION_PATH = ".kino/sessions/cleannest.json";
const CLEAN_NEST_DASHBOARD_URL =
  "https://cleannest-platform-two.vercel.app/admin/dashboard";

let browser;
let context;
let page;

console.log("KINO Session Reuse Test");

try {
  try {
    await access(SESSION_PATH);
  } catch {
    console.error(`Saved CleanNest session not found at ${SESSION_PATH}.`);
    console.error("Please connect the website first using:");
    console.error("npm run web-agent:connect");
    process.exitCode = 1;
  }

  if (!process.exitCode) {
    console.log("Opening CleanNest with saved session...\n");

    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      storageState: SESSION_PATH,
    });
    page = await context.newPage();

    const response = await page.goto(CLEAN_NEST_DASHBOARD_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    const finalUrl = page.url();
    const title = await page.title();
    const finalPath = new URL(finalUrl).pathname.toLowerCase();
    const authenticationReused =
      finalPath === "/admin" || finalPath.startsWith("/admin/");

    console.log(`HTTP Status: ${response?.status() ?? "Unavailable"}`);
    console.log("Final URL:");
    console.log(finalUrl);
    console.log(`Title: ${title}\n`);

    if (authenticationReused) {
      console.log("Authentication state: REUSED SUCCESSFULLY");
      console.log("\nKINO opened CleanNest without requiring login.");
    } else {
      console.log("Authentication state: INVALID OR EXPIRED");
      console.log("\nPlease reconnect the website using:");
      console.log("npm run web-agent:connect");
    }

    console.log("\nBrowser is open.");

    const terminal = createInterface({ input, output });
    try {
      await terminal.question("Press ENTER to close.\n");
    } finally {
      terminal.close();
    }
  }
} catch (error) {
  console.error("Session reuse test failed:", error);
  process.exitCode = 1;
} finally {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } finally {
    try {
      if (context) {
        await context.close();
      }
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }
}
