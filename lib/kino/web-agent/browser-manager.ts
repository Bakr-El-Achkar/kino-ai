import {
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { chromium } from "playwright";
import type {
  Browser,
  BrowserContext,
  BrowserServer,
  Page,
} from "playwright";

import type { NavigationFailureCode, ResolvedConnectedSite } from "./types";
import { isAllowedOrigin } from "./page-safety";

type BrowserSession = {
  browser: Browser;
  context: BrowserContext;
  page: Page;
};

type ManagedBrowserSession = BrowserSession & {
  reused: boolean;
};

type BrowserRuntimeState = {
  siteId: string;
  wsEndpoint: string;
};

type WebAgentProcess = NodeJS.Process & {
  __kinoWebAgentSessions?: Map<string, BrowserSession>;
  __kinoWebAgentSessionCreations?: Map<string, Promise<ManagedBrowserSession>>;
  __kinoWebAgentBrowserServers?: Map<string, BrowserServer>;
};

const RUNTIME_DIRECTORY = resolve(process.cwd(), ".kino/runtime");
const LOCK_WAIT_MILLISECONDS = 100;
const LOCK_ATTEMPTS = 150;
const STALE_LOCK_MILLISECONDS = 30_000;

export class BrowserSessionError extends Error {
  constructor(
    readonly code: NavigationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "BrowserSessionError";
  }
}

/*
  The local maps avoid reconnecting within one Next.js server context.
  The private runtime endpoint below bridges separate dev-server contexts.
*/
const webAgentProcess = process as WebAgentProcess;
const sessions =
  (webAgentProcess.__kinoWebAgentSessions ??= new Map<string, BrowserSession>());
const sessionCreations =
  (webAgentProcess.__kinoWebAgentSessionCreations ??= new Map<
    string,
    Promise<ManagedBrowserSession>
  >());
const browserServers =
  (webAgentProcess.__kinoWebAgentBrowserServers ??= new Map<
    string,
    BrowserServer
  >());

function runtimeStatePath(siteId: string) {
  return resolve(RUNTIME_DIRECTORY, `${siteId}.json`);
}

function runtimeLockPath(siteId: string) {
  return resolve(RUNTIME_DIRECTORY, `${siteId}.lock`);
}

function isInsideDirectory(filePath: string, directoryPath: string) {
  const childPath = relative(directoryPath, filePath);
  return (
    childPath.length > 0 &&
    !childPath.startsWith("..") &&
    !isAbsolute(childPath)
  );
}

function isHealthy(session: BrowserSession, allowedOrigin: string) {
  if (!session.browser.isConnected() || session.page.isClosed()) return false;
  try {
    return (
      session.context.pages().includes(session.page) &&
      isAllowedOrigin(session.page.url(), allowedOrigin)
    );
  } catch {
    return false;
  }
}

async function discardLocalSession(session: BrowserSession) {
  try {
    if (!session.page.isClosed()) await session.page.close();
  } catch {
    // The page may already have closed with its context or browser.
  }
  try {
    await session.context.close();
  } catch {
    // The context may already have closed with its browser.
  }
}

async function resolveStorageStatePath(site: ResolvedConnectedSite) {
  const sessionsRoot = await realpath(resolve(process.cwd(), ".kino/sessions"));
  let storageStatePath: string;

  try {
    storageStatePath = await realpath(site.storageStateAbsolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new BrowserSessionError(
        "SESSION_NOT_FOUND",
        `No saved session is available for ${site.name}. Reconnect the website.`,
      );
    }
    throw error;
  }

  if (!isInsideDirectory(storageStatePath, sessionsRoot)) {
    throw new BrowserSessionError(
      "INVALID_CONNECTION",
      `The saved session path for ${site.name} is outside KINO's private session directory.`,
    );
  }

  return storageStatePath;
}

function isLoopbackWebSocket(endpoint: string) {
  try {
    const url = new URL(endpoint);
    return (
      ["ws:", "wss:"].includes(url.protocol) &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

async function removeRuntimeState(siteId: string) {
  await unlink(runtimeStatePath(siteId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}

async function readRuntimeState(siteId: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(runtimeStatePath(siteId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    await removeRuntimeState(siteId);
    return null;
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("siteId" in parsed) ||
    !("wsEndpoint" in parsed) ||
    parsed.siteId !== siteId ||
    typeof parsed.wsEndpoint !== "string" ||
    !isLoopbackWebSocket(parsed.wsEndpoint)
  ) {
    await removeRuntimeState(siteId);
    return null;
  }

  return parsed as BrowserRuntimeState;
}

async function writeRuntimeState(siteId: string, wsEndpoint: string) {
  await mkdir(RUNTIME_DIRECTORY, { recursive: true });
  await writeFile(
    runtimeStatePath(siteId),
    `${JSON.stringify({ siteId, wsEndpoint })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function acquireRuntimeLock(siteId: string) {
  await mkdir(RUNTIME_DIRECTORY, { recursive: true });
  const lockPath = runtimeLockPath(siteId);

  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      return async () => {
        await handle.close();
        await unlink(lockPath).catch(() => {});
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      try {
        const lockInfo = await stat(lockPath);
        if (Date.now() - lockInfo.mtimeMs > STALE_LOCK_MILLISECONDS) {
          await unlink(lockPath);
          continue;
        }
      } catch (lockError) {
        if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw lockError;
      }

      await new Promise((resolveWait) =>
        setTimeout(resolveWait, LOCK_WAIT_MILLISECONDS),
      );
    }
  }

  throw new BrowserSessionError(
    "BROWSER_ERROR",
    "The connected browser is busy. Try the navigation again.",
  );
}

async function openStartPage(page: Page, site: ResolvedConnectedSite) {
  await page.goto(site.startUrl, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
}

function cacheSession(siteId: string, session: BrowserSession) {
  sessions.set(siteId, session);
  session.browser.on("disconnected", () => {
    if (sessions.get(siteId)?.browser === session.browser) {
      sessions.delete(siteId);
    }
  });
  return session;
}

async function connectToRuntimeBrowser(
  site: ResolvedConnectedSite,
  storageStatePath: string,
) {
  const runtimeState = await readRuntimeState(site.id);
  if (!runtimeState) return null;

  let browser: Browser;
  try {
    browser = await chromium.connect(runtimeState.wsEndpoint, { timeout: 5_000 });
  } catch {
    await removeRuntimeState(site.id);
    return null;
  }

  try {
    const contexts = browser.contexts();
    const page = contexts
      .flatMap((context) => context.pages())
      .find(
        (candidate) =>
          !candidate.isClosed() &&
          isAllowedOrigin(candidate.url(), site.allowedOrigin),
      );

    if (page) {
      return cacheSession(site.id, {
        browser,
        context: page.context(),
        page,
      });
    }

    /*
      A Playwright browser server can outlive a Next.js module reload.
      Never adopt its first tab blindly: it may be an error page, a blank
      tab, or a stale context without the connected site's session state.
    */
    await Promise.all(
      contexts.map((context) => context.close().catch(() => {})),
    );

    const context = await browser.newContext({ storageState: storageStatePath });
    const freshPage = await context.newPage();
    await openStartPage(freshPage, site);

    return cacheSession(site.id, { browser, context, page: freshPage });
  } catch (error) {
    await removeRuntimeState(site.id);
    throw error;
  }
}

async function launchRuntimeBrowser(
  site: ResolvedConnectedSite,
  storageStatePath: string,
) {
  const browserServer = await chromium.launchServer({ headless: false });

  try {
    const wsEndpoint = browserServer.wsEndpoint();
    if (!isLoopbackWebSocket(wsEndpoint)) {
      throw new BrowserSessionError(
        "BROWSER_ERROR",
        "Playwright did not create a private loopback browser endpoint.",
      );
    }

    const browser = await chromium.connect(wsEndpoint, { timeout: 5_000 });
    const context = await browser.newContext({ storageState: storageStatePath });
    const page = await context.newPage();
    await openStartPage(page, site);
    await writeRuntimeState(site.id, wsEndpoint);

    browserServers.set(site.id, browserServer);
    browserServer.on("close", () => {
      if (browserServers.get(site.id) === browserServer) {
        browserServers.delete(site.id);
      }
      void removeRuntimeState(site.id);
    });

    return cacheSession(site.id, { browser, context, page });
  } catch (error) {
    await browserServer.close().catch(() => {});
    await removeRuntimeState(site.id);
    throw error;
  }
}

async function createOrConnectSession(site: ResolvedConnectedSite) {
  const storageStatePath = await resolveStorageStatePath(site);
  const releaseLock = await acquireRuntimeLock(site.id);

  try {
    const existing = sessions.get(site.id);
    if (existing && isHealthy(existing, site.allowedOrigin)) {
      return { ...existing, reused: true };
    }

    const connected = await connectToRuntimeBrowser(site, storageStatePath);
    if (connected) return { ...connected, reused: true };
    return { ...(await launchRuntimeBrowser(site, storageStatePath)), reused: false };
  } finally {
    await releaseLock();
  }
}

export async function getBrowserSession(
  site: ResolvedConnectedSite,
): Promise<ManagedBrowserSession> {
  const existing = sessions.get(site.id);
  if (existing && isHealthy(existing, site.allowedOrigin)) {
    return { ...existing, reused: true };
  }

  if (existing) {
    sessions.delete(site.id);
    await discardLocalSession(existing);
  }

  const pending = sessionCreations.get(site.id);
  if (pending) return { ...(await pending), reused: true };

  const creation = createOrConnectSession(site);
  sessionCreations.set(site.id, creation);
  try {
    return await creation;
  } finally {
    if (sessionCreations.get(site.id) === creation) {
      sessionCreations.delete(site.id);
    }
  }
}
