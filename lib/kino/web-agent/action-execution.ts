import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";

import {
  isExplicitCancellation,
  parseActionConfirmation,
} from "./action-confirmation";
import { discoverLiveWebActions } from "./action-discovery";
import { normalizeActionText } from "./action-matcher";
import { recordActionAuditEvent } from "./audit";
import { BrowserSessionError, getBrowserSession } from "./browser-manager";
import { ConnectionError, getConnectedSite } from "./connections";
import {
  isAllowedOrigin,
  isAuthenticationRoute,
  safeUrlForLog,
  settleVisiblePage,
} from "./page-safety";
import {
  cancelScopedPendingWebAction,
  getScopedPendingWebAction,
  promotePendingWebActionToCritical,
  transitionPendingWebAction,
} from "./pending-actions";
import type { KinoToolContext } from "../tools/types";
import type { PendingWebAction, WebActionRisk } from "./action-types";

const VERIFICATION_TIMEOUT_MILLISECONDS = 5_000;
const VERIFICATION_POLL_MILLISECONDS = 250;

type SafeUiState = {
  url: string;
  titleHash: string;
  dialogs: number;
  forms: number;
  headings: number;
  controls: number;
  structureHash: string;
};

async function visibleCount(locator: Locator, maximum = 100) {
  const count = Math.min(await locator.count(), maximum);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    try {
      if (await locator.nth(index).isVisible()) visible += 1;
    } catch {
      // Ignore elements that detach while the application updates.
    }
  }
  return visible;
}

async function captureSafeUiState(page: Page): Promise<SafeUiState> {
  const [dialogs, forms, headings, ...controlCounts] = await Promise.all([
    visibleCount(page.getByRole("dialog")),
    visibleCount(page.getByRole("form")),
    visibleCount(page.getByRole("heading")),
    visibleCount(page.getByRole("textbox")),
    visibleCount(page.getByRole("searchbox")),
    visibleCount(page.getByRole("combobox")),
    visibleCount(page.getByRole("checkbox")),
    visibleCount(page.getByRole("radio")),
  ]);
  const titleHash = createHash("sha256")
    .update(await page.title())
    .digest("hex")
    .slice(0, 16);
  const controls = controlCounts.reduce((total, count) => total + count, 0);
  const structureHash = createHash("sha256")
    .update(JSON.stringify({ dialogs, forms, headings, controls, titleHash }))
    .digest("hex")
    .slice(0, 16);
  return {
    url: safeUrlForLog(page.url()),
    titleHash,
    dialogs,
    forms,
    headings,
    controls,
    structureHash,
  };
}

function verificationEvidence(before: SafeUiState, after: SafeUiState) {
  if (after.dialogs > before.dialogs) {
    return {
      effectVerified: true,
      verificationType: "dialog_appeared",
      evidence: "A new dialog appeared.",
    };
  }
  if (after.forms > before.forms || after.controls > before.controls) {
    return {
      effectVerified: true,
      verificationType: "form_interface_appeared",
      evidence: "A new form interface appeared.",
    };
  }
  if (after.url !== before.url) {
    return {
      effectVerified: true,
      verificationType: "same_origin_url_changed",
      evidence: "The same-site page URL changed.",
    };
  }
  if (
    after.headings !== before.headings ||
    after.titleHash !== before.titleHash ||
    after.structureHash !== before.structureHash
  ) {
    return {
      effectVerified: true,
      verificationType: "semantic_structure_changed",
      evidence: "The visible semantic page structure changed.",
    };
  }
  return {
    effectVerified: false,
    verificationType: "no_reliable_change",
    evidence: "The control was activated, but no reliable UI change was detected.",
  };
}

async function observeEffect(page: Page, before: SafeUiState) {
  const deadline = Date.now() + VERIFICATION_TIMEOUT_MILLISECONDS;
  let after = await captureSafeUiState(page);
  let evidence = verificationEvidence(before, after);

  while (!evidence.effectVerified && Date.now() < deadline) {
    await page.waitForTimeout(VERIFICATION_POLL_MILLISECONDS);
    after = await captureSafeUiState(page);
    evidence = verificationEvidence(before, after);
  }
  return { after, ...evidence };
}

function auditFor(
  context: KinoToolContext,
  action: PendingWebAction,
  status: Parameters<typeof recordActionAuditEvent>[0]["status"],
  extras: Partial<Parameters<typeof recordActionAuditEvent>[0]> = {},
) {
  recordActionAuditEvent({
    conversationId: context.conversationId,
    siteId: action.siteId,
    pendingActionId: action.id,
    actionName: action.matchedName,
    role: action.role,
    risk: action.risk,
    status,
    ...extras,
  });
}

function riskRank(risk: WebActionRisk) {
  return { read: 0, write: 1, critical: 2 }[risk];
}

export async function executePendingConnectedAction({
  siteId,
  context,
}: {
  siteId?: string;
  context: KinoToolContext;
}) {
  let site;
  try {
    site = await getConnectedSite(siteId);
  } catch (error) {
    if (error instanceof ConnectionError) {
      return { success: false, status: error.code, message: error.message };
    }
    throw error;
  }

  const scoped = getScopedPendingWebAction(
    context.conversationId,
    site.id,
    new Date(),
  );
  if (scoped.status === "NO_ACTION_PENDING") {
    return {
      success: false,
      status: "NO_ACTION_PENDING",
      message: "There is no pending action for this conversation and website.",
    };
  }
  if (scoped.status === "MULTIPLE_ACTIONS_PENDING") {
    return {
      success: false,
      status: "MULTIPLE_ACTIONS_PENDING",
      message: "Multiple pending actions were detected. Nothing was executed.",
    };
  }
  if (scoped.status === "EXPIRED_ACTION") {
    auditFor(context, scoped.action, "ACTION_EXPIRED");
    return {
      success: false,
      status: "EXPIRED_ACTION",
      message: "The pending action expired and was not executed.",
    };
  }

  const action = scoped.action;
  const confirmation = parseActionConfirmation({
    message: context.latestUserMessage,
    risk: action.risk,
    requiredPhrase: action.requiredConfirmationPhrase,
  });
  if (!confirmation.explicit) {
    auditFor(context, action, "ACTION_CONFIRMATION_REJECTED");
    return {
      success: false,
      status: confirmation.reason,
      message:
        confirmation.reason === "STRONG_CONFIRMATION_REQUIRED"
          ? `This critical action requires the exact phrase: ${action.requiredConfirmationPhrase}`
          : "The latest user message is not an explicit confirmation. Nothing was executed.",
      requiredConfirmationPhrase:
        confirmation.reason === "STRONG_CONFIRMATION_REQUIRED"
          ? action.requiredConfirmationPhrase
          : undefined,
    };
  }

  auditFor(context, action, "ACTION_CONFIRMATION_ACCEPTED");
  if (!transitionPendingWebAction(action.id, "pending", "executing")) {
    return {
      success: false,
      status: "NO_ACTION_PENDING",
      message: "The pending action is no longer available for execution.",
    };
  }

  let controlActivated = false;
  try {
    const session = await getBrowserSession(site);
    const { page } = session;
    await settleVisiblePage(page);

    const currentUrl = page.url();
    if (isAuthenticationRoute(currentUrl)) {
      transitionPendingWebAction(action.id, "executing", "failed");
      auditFor(context, action, "ACTION_EXECUTION_FAILED");
      return {
        success: false,
        status: "AUTH_EXPIRED",
        message: "The saved website session expired. Nothing was executed.",
        browserReused: session.reused,
      };
    }
    if (!isAllowedOrigin(currentUrl, site.allowedOrigin)) {
      transitionPendingWebAction(action.id, "executing", "failed");
      auditFor(context, action, "ACTION_EXECUTION_FAILED");
      return {
        success: false,
        status: "UNEXPECTED_ORIGIN",
        message: "The connected browser is outside its allowed origin. Nothing was executed.",
        browserReused: session.reused,
      };
    }
    if (safeUrlForLog(currentUrl) !== action.fingerprint.pageUrl) {
      transitionPendingWebAction(action.id, "executing", "failed");
      auditFor(context, action, "ACTION_BLOCKED_CONTEXT_CHANGED");
      return {
        success: false,
        status: "ACTION_CONTEXT_CHANGED",
        message: "The current page changed after preparation. Nothing was executed.",
        browserReused: session.reused,
      };
    }

    const liveActions = await discoverLiveWebActions(page);
    const matches = liveActions.filter(
      ({ candidate }) =>
        candidate.role === action.fingerprint.role &&
        normalizeActionText(candidate.name) ===
          normalizeActionText(action.fingerprint.accessibleName),
    );
    if (matches.length === 0) {
      transitionPendingWebAction(action.id, "executing", "failed");
      auditFor(context, action, "ACTION_EXECUTION_FAILED");
      return {
        success: false,
        status: "ACTION_NO_LONGER_AVAILABLE",
        message: "The prepared control is no longer available. Nothing was executed.",
        browserReused: session.reused,
      };
    }
    if (matches.length !== 1) {
      transitionPendingWebAction(action.id, "executing", "failed");
      auditFor(context, action, "ACTION_EXECUTION_FAILED");
      return {
        success: false,
        status: "ACTION_BECAME_AMBIGUOUS",
        message: "The prepared control is now ambiguous. Nothing was executed.",
        browserReused: session.reused,
      };
    }

    const [{ candidate, locator }] = matches;
    if (candidate.destination === "external" || candidate.destination === "unsafe") {
      transitionPendingWebAction(action.id, "executing", "failed");
      auditFor(context, action, "ACTION_EXECUTION_FAILED");
      return {
        success: false,
        status: "UNSAFE_ACTION_BLOCKED",
        message: "The prepared control is no longer safe to activate.",
        browserReused: session.reused,
      };
    }
    if (riskRank(candidate.risk) < riskRank(action.risk)) {
      transitionPendingWebAction(action.id, "executing", "failed");
      auditFor(context, action, "ACTION_EXECUTION_FAILED");
      return {
        success: false,
        status: "ACTION_RISK_CHANGED",
        message: "The action risk changed unexpectedly. Nothing was executed.",
        browserReused: session.reused,
      };
    }
    if (action.risk === "write" && candidate.risk === "critical") {
      const promoted = promotePendingWebActionToCritical(action.id, candidate.name);
      return {
        success: false,
        status: "CRITICAL_CONFIRMATION_REQUIRED",
        message: `The live action is now critical. Type exactly: ${promoted?.requiredConfirmationPhrase}`,
        requiredConfirmationPhrase: promoted?.requiredConfirmationPhrase,
        browserReused: session.reused,
      };
    }
    if (!(await locator.isVisible()) || !(await locator.isEnabled())) {
      transitionPendingWebAction(action.id, "executing", "failed");
      auditFor(context, action, "ACTION_EXECUTION_FAILED");
      return {
        success: false,
        status: "ACTION_NOT_INTERACTABLE",
        message: "The prepared control is not visible and enabled. Nothing was executed.",
        browserReused: session.reused,
      };
    }

    auditFor(context, action, "ACTION_REVALIDATED");
    auditFor(context, action, "ACTION_EXECUTION_STARTED");
    const before = await captureSafeUiState(page);
    await locator.click({ timeout: 15_000 });
    controlActivated = true;
    auditFor(context, action, "ACTION_CONTROL_ACTIVATED");

    const observation = await observeEffect(page, before);
    let effectVerified = observation.effectVerified;
    let verificationType = observation.verificationType;
    let evidence = observation.evidence;
    if (!isAllowedOrigin(page.url(), site.allowedOrigin)) {
      effectVerified = false;
      verificationType = "unexpected_origin";
      evidence = "The control changed the page origin unexpectedly.";
    }

    transitionPendingWebAction(action.id, "executing", "executed");
    auditFor(
      context,
      action,
      effectVerified ? "ACTION_VERIFIED" : "ACTION_VERIFICATION_UNCERTAIN",
      { verificationType },
    );
    return {
      success: true,
      status: effectVerified ? "ACTION_EFFECT_VERIFIED" : "ACTION_EFFECT_UNCERTAIN",
      site: { id: site.id, name: site.name },
      matched: candidate.name,
      role: candidate.role,
      risk: candidate.risk,
      browserReused: session.reused,
      revalidated: true,
      riskUnchanged: candidate.risk === action.risk,
      execution: { controlActivated: true, effectVerified, evidence },
      message: effectVerified
        ? `${evidence} The prepared control was activated exactly once; no form was filled or submitted.`
        : `${evidence} No form was filled or submitted.`,
    };
  } catch (error) {
    transitionPendingWebAction(
      action.id,
      "executing",
      controlActivated ? "executed" : "failed",
    );
    auditFor(
      context,
      action,
      controlActivated
        ? "ACTION_VERIFICATION_UNCERTAIN"
        : "ACTION_EXECUTION_FAILED",
      { verificationType: controlActivated ? "verification_error" : undefined },
    );
    if (error instanceof BrowserSessionError) {
      return {
        success: false,
        status: error.code,
        message: error.message,
      };
    }
    if (controlActivated) {
      return {
        success: true,
        status: "ACTION_EFFECT_UNCERTAIN",
        execution: {
          controlActivated: true,
          effectVerified: false,
          evidence: "The control was activated, but verification could not be completed.",
        },
        message: "The control was activated once, but its resulting state could not be verified. No form was filled or submitted.",
      };
    }
    return {
      success: false,
      status: "ACTION_EXECUTION_FAILED",
      message: "The prepared control could not be activated. Nothing was executed.",
    };
  }
}

export async function cancelPendingConnectedAction({
  siteId,
  context,
}: {
  siteId?: string;
  context: KinoToolContext;
}) {
  if (context.source !== "chat" || !isExplicitCancellation(context.latestUserMessage)) {
    return {
      success: false,
      status: "CANCELLATION_NOT_EXPLICIT",
      message: "The latest user message is not an explicit cancellation.",
    };
  }

  let site;
  try {
    site = await getConnectedSite(siteId);
  } catch (error) {
    if (error instanceof ConnectionError) {
      return { success: false, status: error.code, message: error.message };
    }
    throw error;
  }

  const result = cancelScopedPendingWebAction(
    context.conversationId,
    site.id,
    new Date(),
  );
  if (result.status === "NO_ACTION_PENDING") {
    return {
      success: false,
      status: "NO_ACTION_PENDING",
      message: "There is no pending action to cancel in this conversation.",
    };
  }
  if (result.status === "MULTIPLE_ACTIONS_PENDING") {
    return {
      success: false,
      status: "MULTIPLE_ACTIONS_PENDING",
      message: "Multiple pending actions were detected. Nothing was cancelled or executed.",
    };
  }
  if (result.status === "EXPIRED_ACTION") {
    auditFor(context, result.action, "ACTION_EXPIRED");
    return {
      success: false,
      status: "EXPIRED_ACTION",
      message: "The pending action already expired.",
    };
  }

  auditFor(context, result.action, "ACTION_CANCELLED");
  return {
    success: true,
    status: "ACTION_CANCELLED",
    matched: result.action.matchedName,
    message: "The pending action was cancelled. Nothing was executed.",
  };
}
