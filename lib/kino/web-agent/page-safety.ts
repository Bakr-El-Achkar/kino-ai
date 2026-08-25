import type { Page } from "playwright";

export function isAuthenticationRoute(url: string) {
  const pathname = new URL(url).pathname.toLowerCase();
  return /\/(?:login|sign-in|signin)(?:\/|$)/.test(pathname);
}

export function isAllowedOrigin(url: string, allowedOrigin: string) {
  return new URL(url).origin === allowedOrigin;
}

export function safeUrlForLog(url: string) {
  const safeUrl = new URL(url);
  safeUrl.username = "";
  safeUrl.password = "";
  safeUrl.search = "";
  safeUrl.hash = "";
  return safeUrl.href;
}

export async function settleVisiblePage(page: Page) {
  try {
    await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    /*
      A long-lived headed browser can retain a same-origin URL while its
      document is left half-loaded after a network or memory interruption.
      Reload once before declaring the connected page unreadable.
    */
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
  }
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
}
