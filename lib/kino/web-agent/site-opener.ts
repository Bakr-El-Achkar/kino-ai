import { BrowserSessionError, getBrowserSession } from "./browser-manager";
import { ConnectionError, getConnectedSite } from "./connections";
import {
  isAllowedOrigin,
  isAuthenticationRoute,
  safeUrlForLog,
  settleVisiblePage,
} from "./page-safety";

export async function openConnectedSite(siteId?: string) {
  let site;
  try {
    site = await getConnectedSite(siteId);
  } catch (error) {
    if (error instanceof ConnectionError) {
      return {
        success: false,
        status: error.code,
        message: error.message,
        availableSites: error.availableSites,
      };
    }
    throw error;
  }

  try {
    const session = await getBrowserSession(site);
    const { page } = session;
    await settleVisiblePage(page);
    const currentUrl = page.url();
    if (isAuthenticationRoute(currentUrl)) {
      return {
        success: false,
        status: "AUTH_EXPIRED",
        message: "The saved website session expired. Reconnect the website.",
        site: { id: site.id, name: site.name },
        browserReused: session.reused,
      };
    }
    if (!isAllowedOrigin(currentUrl, site.allowedOrigin)) {
      return {
        success: false,
        status: "UNEXPECTED_ORIGIN",
        message: "The connected browser is outside its configured website origin.",
        site: { id: site.id, name: site.name },
        browserReused: session.reused,
      };
    }
    return {
      success: true,
      status: "SITE_OPEN",
      site: { id: site.id, name: site.name },
      currentUrl: safeUrlForLog(currentUrl),
      authentication: "ACTIVE" as const,
      browserReused: session.reused,
      message: `${site.name} is open in its authenticated connected browser session.`,
    };
  } catch (error) {
    if (error instanceof BrowserSessionError) {
      return { success: false, status: error.code, message: error.message };
    }
    console.error(
      "Web Agent site open error:",
      error instanceof Error ? error.message : "Unknown browser error.",
    );
    return {
      success: false,
      status: "BROWSER_ERROR",
      message: "The connected website could not be opened.",
    };
  }
}
