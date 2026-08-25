import { getConnectedSites } from "./connections";
import { getFormDraftRuntimeSummary } from "./form-drafts";
import { getPendingActionRuntimeSummary } from "./pending-actions";
import { getFormFillRuntimeSummary } from "./pending-form-fills";
import { getSensitiveFormFillRuntimeSummary } from "./ephemeral-secrets";

export async function getWebAgentRuntimeStateMessage(conversationId: string) {
  // Recompute this block for every model round; persisted state, not chat history, is authoritative.
  const pending = getPendingActionRuntimeSummary(conversationId);
  const draft = getFormDraftRuntimeSummary(conversationId);
  const fill = getFormFillRuntimeSummary(conversationId);
  const sensitiveFill = getSensitiveFormFillRuntimeSummary(conversationId);
  let pendingWebsiteAction: Record<string, unknown> = { exists: false };
  if (pending.exists) {
    const sites = await getConnectedSites();
    const site = sites.find((candidate) => candidate.id === pending.siteId);
    pendingWebsiteAction = {
      exists: true,
      site: site?.name ?? pending.siteId,
      matchedAction: pending.matchedAction,
      risk: pending.risk,
      expiresInSeconds: pending.expiresInSeconds,
    };
  }

  let formDraft: Record<string, unknown> = { exists: false };
  if (draft.exists) {
    const sites = await getConnectedSites();
    const site = sites.find((candidate) => candidate.id === draft.siteId);
    formDraft = {
      exists: true,
      site: site?.name ?? draft.siteId,
      status: draft.status,
      missingRequired: draft.missingRequired,
      expiresInSeconds: draft.expiresInSeconds,
    };
  }

  let formFill: Record<string, unknown> = { exists: false };
  if (fill.exists) {
    const sites = await getConnectedSites();
    const site = sites.find((candidate) => candidate.id === fill.siteId);
    formFill = {
      exists: true,
      site: site?.name ?? fill.siteId,
      status: fill.status,
      fieldCount: fill.fieldCount,
      verifiedCount: fill.verifiedCount,
      failedCount: fill.failedCount,
      expiresInSeconds: fill.expiresInSeconds,
    };
  }

  let sensitiveFormFill: Record<string, unknown> = { exists: false };
  if (sensitiveFill.exists) {
    const sites = await getConnectedSites();
    const site = sites.find((candidate) => candidate.id === sensitiveFill.siteId);
    sensitiveFormFill = {
      exists: true,
      site: site?.name ?? sensitiveFill.siteId,
      stage: sensitiveFill.stage,
      fieldName: sensitiveFill.fieldName,
      expiresInSeconds: sensitiveFill.expiresInSeconds,
      filled: sensitiveFill.filled,
      verified: sensitiveFill.verified,
    };
  }

  return [
    "KINO_RUNTIME_STATE (server-generated; authoritative; never invent or modify):",
    JSON.stringify({
      pendingWebsiteAction,
      formDraft,
      formFill,
      sensitiveFormFill,
      formDraftFollowUpPolicy:
        "If formDraft exists and the user supplies, corrects, or requests generation of field data, call web_prepare_form_draft. Do not merely acknowledge the data.",
      capabilities: {
        formUnderstanding: true,
        formDrafting: true,
        syntheticTestDraftValues: true,
        ordinaryFormFilling: true,
        sensitiveAuthenticationFormFilling: true,
        paymentOrIdentitySensitiveFormFilling: false,
        formSubmission: false,
        recordCreation: false,
      },
    }),
  ].join("\n");
}
