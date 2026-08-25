import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const CLEAN_NEST_URL = "https://cleannest-platform-two.vercel.app";
const SESSION_DIRECTORY = ".kino/sessions";
const SESSION_PATH = `${SESSION_DIRECTORY}/cleannest.json`;

let browser;

console.log("KINO Website Connection");

try {
  await mkdir(SESSION_DIRECTORY, { recursive: true });

  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto(CLEAN_NEST_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  console.log("CleanNest opened.");
  console.log("\nPlease log in manually in the browser.");
  console.log(
    "\nAfter you are fully logged in and can see the authenticated CleanNest application,",
  );

  const terminal = createInterface({ input, output });
  try {
    await terminal.question(
      "return to this terminal and press ENTER to save the session.\n",
    );
  } finally {
    terminal.close();
  }

  const finalUrl = page.url();
  const title = await page.title();

  await context.storageState({
    path: SESSION_PATH,
    indexedDB: true,
  });

  console.log("\nSession saved successfully.");
  console.log(`Final URL: ${finalUrl}`);
  console.log(`Title: ${title}`);
  console.log("Session file:");
  console.log(SESSION_PATH);
} catch (error) {
  console.error("Failed to connect CleanNest:", error);
  process.exitCode = 1;
} finally {
  if (browser) {
    await browser.close();
  }
}
