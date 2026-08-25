import { matchWebAction } from "./action-matcher";
import { discoverWebActions } from "./action-discovery";
import { recordActionAuditEvent } from "./audit";
import { BrowserSessionError, getBrowserSession } from "./browser-manager";
import { requiresConfirmation } from "./confirmation-policy";
import { ConnectionError, getConnectedSite } from "./connections";
import {
  isAllowedOrigin,
  isAuthenticationRoute,
  safeUrlForLog,
  settleVisiblePage,
} from "./page-safety";
import { createPendingWebAction } from "./pending-actions";
import type { NavigationFailureCode, ResolvedConnectedSite } from "./types";

const MAX_INTENT_LENGTH = 200;

export type PrepareConnectedActionInput = {
  conversationId: string;
  siteId?: string;
  intent: string;
};

type PrepareActionFailureCode =
  | NavigationFailureCode
  | "NO_ACTION_MATCH"
  | "AMBIGUOUS_ACTION"
  | "ACTION_PREPARATION_ERROR";

type PrepareActionFailure = {
  success: false;
  status: PrepareActionFailureCode;
  message: string;
  requested?: string;
  site?: { id: string; name: string };
  candidates?: string[];
  availableSites?: Array<{ id: string; name: string }>;
  browserReused?: boolean;
};

type PrepareActionReadResult = {
  success: true;
  status: "USE_WEB_NAVIGATE";
  site: { id: string; name: string };
  requested: string;
  matched: string;
  role: string;
  risk: "read";
  browserReused: boolean;
  message: string;
};

type PrepareActionPendingResult = {
  success: true;
  status: "CONFIRMATION_REQUIRED";
  pendingAction: {
    id: string;
    site: { id: string; name: string };
    requested: string;
    matched: string;
    role: string;
    risk: "write" | "critical";
    expiresAt: string;
    requiredConfirmationPhrase?: string;
  };
  browserReused: boolean;
  message: string;
};

export type PrepareConnectedActionResult =
  | PrepareActionFailure
  | PrepareActionReadResult
  | PrepareActionPendingResult;

function siteSummary(site: ResolvedConnectedSite) {
  return { id: site.id, name: site.name };
}

function failure(
  result: Omit<PrepareActionFailure, "success">,
): PrepareActionFailure {
  return { success: false, ...result };
}

export async function prepareConnectedAction({
  conversationId,
  siteId,
  intent,
}: PrepareConnectedActionInput): Promise<PrepareConnectedActionResult> {
  const requested = intent.trim().replace(/\s+/g, " ");
  if (!requested || requested.length > MAX_INTENT_LENGTH) {
    return failure({
      status: "INVALID_ARGUMENTS",
      message: "A concise action intent is required.",
    });
  }

  let site: ResolvedConnectedSite;
  try {
    site = await getConnectedSite(siteId);
  } catch (error) {
    if (error instanceof ConnectionError) {
      return failure({
        status: error.code,
        message: error.message,
        requested,
        availableSites: error.availableSites,
      });
    }
    throw error;
  }

  const summary = siteSummary(site);

  try {
    const session = await getBrowserSession(site);
    const { page } = session;
    console.log(
      `Web Agent: ${session.reused ? "Reusing" : "Opened"} visible browser session for action preparation on ${site.name}.`,
    );
    await settleVisiblePage(page);

    const currentUrl = page.url();
    if (isAuthenticationRoute(currentUrl)) {
      return failure({
        status: "AUTH_EXPIRED",
        message: "The saved website session has expired. Reconnect the website.",
        requested,
        site: summary,
        browserReused: session.reused,
      });
    }
    if (!isAllowedOrigin(currentUrl, site.allowedOrigin)) {
      return failure({
        status: "UNEXPECTED_ORIGIN",
        message: "The connected browser is not on its allowed website origin.",
        requested,
        site: summary,
        browserReused: session.reused,
      });
    }

    let candidates = await discoverWebActions(page);
    let match = matchWebAction(requested, candidates);

    // A client-rendered page can update its action bar just after navigation.
    // Re-inspect once before returning a false no-match; inspection remains read-only.
    if (match.status === "NO_ACTION_MATCH") {
      await page.waitForTimeout(750);
      candidates = await discoverWebActions(page);
      match = matchWebAction(requested, candidates);
    }

    recordActionAuditEvent({
      conversationId,
      siteId: site.id,
      status: "ACTION_DISCOVERED",
    });

    if (match.status === "NO_ACTION_MATCH") {
      recordActionAuditEvent({
        conversationId,
        siteId: site.id,
        status: "ACTION_REJECTED_NO_MATCH",
      });
      return failure({
        status: match.status,
        message: "No matching visible action is available on the current page.",
        requested,
        site: summary,
        candidates: match.candidates,
        browserReused: session.reused,
      });
    }

    if (match.status === "AMBIGUOUS_ACTION") {
      recordActionAuditEvent({
        conversationId,
        siteId: site.id,
        status: "ACTION_REJECTED_AMBIGUOUS",
      });
      return failure({
        status: match.status,
        message: "Multiple equally strong visible actions match the request.",
        requested,
        site: summary,
        candidates: match.candidates,
        browserReused: session.reused,
      });
    }

    const { candidate } = match;
    if (!requiresConfirmation(candidate.risk)) {
      return {
        success: true,
        status: "USE_WEB_NAVIGATE",
        site: summary,
        requested,
        matched: candidate.name,
        role: candidate.role,
        risk: "read",
        browserReused: session.reused,
        message: "This is a read-only navigation action; use the existing web navigation tool.",
      };
    }

    const pendingAction = createPendingWebAction({
      conversationId,
      siteId: site.id,
      pageUrl: safeUrlForLog(currentUrl),
      requestedIntent: requested,
      matchedName: candidate.name,
      role: candidate.role,
      risk: candidate.risk,
    });
    recordActionAuditEvent({
      conversationId,
      siteId: site.id,
      actionName: candidate.name,
      risk: candidate.risk,
      pendingActionId: pendingAction.id,
      status: "ACTION_PREPARED",
    });

    return {
      success: true,
      status: "CONFIRMATION_REQUIRED",
      pendingAction: {
        id: pendingAction.id,
        site: summary,
        requested,
        matched: candidate.name,
        role: candidate.role,
        risk: candidate.risk,
        expiresAt: pendingAction.expiresAt,
        requiredConfirmationPhrase: pendingAction.requiredConfirmationPhrase,
      },
      browserReused: session.reused,
      message:
        candidate.risk === "critical"
          ? `I found ${JSON.stringify(candidate.name)}. This is a critical action. To proceed, the user must type exactly: ${pendingAction.requiredConfirmationPhrase}. Nothing was executed.`
          : `I found ${JSON.stringify(candidate.name)}. This write action can modify application data and requires explicit confirmation. Nothing was executed.`,
    };
  } catch (error) {
    if (error instanceof BrowserSessionError) {
      return failure({
        status: error.code,
        message: error.message,
        requested,
        site: summary,
      });
    }

    console.error(
      "Web Agent action preparation error:",
      error instanceof Error ? error.message : "Unknown preparation error.",
    );
    return failure({
      status: "ACTION_PREPARATION_ERROR",
      message: "The requested action could not be prepared.",
      requested,
      site: summary,
    });
  }
}
