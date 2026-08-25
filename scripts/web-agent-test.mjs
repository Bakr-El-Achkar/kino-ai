import { chromium } from "playwright";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const CLEAN_NEST_URL = "https://cleannest-platform-two.vercel.app";
let browser;

console.log("KINO Web Agent Test");

try {
  console.log("Opening CleanNest...");

  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(CLEAN_NEST_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  console.log(`HTTP Status: ${response?.status() ?? "Unavailable"}`);
  console.log(`URL: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);
  console.log("Browser is open.");

  const terminal = createInterface({ input, output });
  try {
    await terminal.question("Press ENTER to close.\n");
  } finally {
    terminal.close();
  }
} catch (error) {
  console.error("Web agent test failed:", error);
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close();
  }
}
