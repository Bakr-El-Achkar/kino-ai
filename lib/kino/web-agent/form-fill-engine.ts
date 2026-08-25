import { isExplicitCancellation, parseActionConfirmation } from "./action-confirmation";
import { recordActionAuditEvent } from "./audit";
import { BrowserSessionError, getBrowserSession } from "./browser-manager";
import { ConnectionError, getConnectedSite } from "./connections";
import { discoverLiveWebForm, type LiveWebForm } from "./form-discovery";
import {
  executeValidatedFormFillPlan,
  rediscoverFormFillField,
  supportedFormFillField,
} from "./form-fill-mutation";
import { getScopedFormDraft } from "./form-drafts";
import { isSensitiveFormField } from "./form-matcher";
import type {
  FormDraftFieldValue,
  FormFillFieldIdentity,
  StoredFormDraft,
  SupportedFormFillFieldType,
} from "./form-types";
import { validateFormValue } from "./form-validation";
import {
  cancelScopedPendingFormFill,
  createPendingFormFill,
  formFillContextChanged,
  getScopedPendingFormFill,
  transitionFormFill,
} from "./pending-form-fills";
import {
  isAllowedOrigin,
  isAuthenticationRoute,
  safeUrlForLog,
  settleVisiblePage,
} from "./page-safety";
import type { KinoToolContext } from "../tools/types";

const MAX_FILL_FIELDS = 25;

type RevalidatedField = {
  identity: FormFillFieldIdentity;
  value: FormDraftFieldValue;
  live: LiveWebForm["fields"][number];
};

function audit(
  conversationId: string,
  siteId: string,
  status: Parameters<typeof recordActionAuditEvent>[0]["status"],
  extras: Partial<Parameters<typeof recordActionAuditEvent>[0]> = {},
) {
  recordActionAuditEvent({ conversationId, siteId, risk: "write", status, ...extras });
}

function safePlanField(identity: FormFillFieldIdentity) {
  return { field: identity.name, fieldType: identity.fieldType };
}

function identityFor(
  field: StoredFormDraft["fields"][number],
): FormFillFieldIdentity | null {
  if (
    ![
      "text",
      "email",
      "tel",
      "number",
      "date",
      "datetime",
      "textarea",
      "select",
      "checkbox",
    ].includes(field.fieldType)
  ) return null;
  return {
    draftFieldId: field.id,
    name: field.name,
    role: field.role,
    fieldType: field.fieldType as SupportedFormFillFieldType,
  };
}

function draftLookup(draft: StoredFormDraft, id: string) {
  return draft.provided.find((value) => value.fieldId === id);
}

async function validateLivePlan({
  liveForm,
  draft,
  identities,
}: {
  liveForm: LiveWebForm;
  draft: StoredFormDraft;
  identities: FormFillFieldIdentity[];
}): Promise<
  | { success: true; fields: RevalidatedField[] }
  | { success: false; status: string; field?: string; message: string }
> {
  const fields: RevalidatedField[] = [];
  for (const identity of identities) {
    const found = rediscoverFormFillField(identity, liveForm.fields);
    if (found.status !== "MATCHED") {
      return {
        success: false,
        status: found.status,
        field: identity.name,
        message:
          found.status === "FIELD_AMBIGUOUS"
            ? `${identity.name} now matches multiple controls.`
            : `${identity.name} is no longer available.`,
      };
    }
    const { field, locator } = found.live;
    if (
      isSensitiveFormField(field) ||
      !supportedFormFillField(field) ||
      field.disabled ||
      field.readonly ||
      !(await locator.isVisible()) ||
      !(await locator.isEnabled())
    ) {
      return {
        success: false,
        status: "FIELD_NOT_AVAILABLE",
        field: identity.name,
        message: `${identity.name} is not safely editable.`,
      };
    }
    const value = draftLookup(draft, identity.draftFieldId);
    if (!value || value.fieldType !== field.fieldType) {
      return {
        success: false,
        status: "FIELD_NOT_AVAILABLE",
        field: identity.name,
        message: `${identity.name} no longer has an approved matching draft value.`,
      };
    }
    const validation = validateFormValue(field, value.value);
    if (!validation.valid) {
      return {
        success: false,
        status: "INVALID_VALUE",
        field: identity.name,
        message: validation.message,
      };
    }
    fields.push({
      identity,
      live: found.live,
      value: { ...value, value: validation.value },
    });
  }
  return { success: true, fields };
}

function contextFailure(status: string, message: string, browserReused?: boolean) {
  return {
    success: false,
    status,
    message,
    browserReused,
    browserMutation: false,
    submitted: false,
  };
}

export async function prepareConnectedFormFill({
  conversationId,
  siteId,
}: {
  conversationId: string;
  siteId?: string;
}) {
  let site;
  try {
    site = await getConnectedSite(siteId);
  } catch (error) {
    if (error instanceof ConnectionError) {
      return contextFailure(error.code, error.message);
    }
    throw error;
  }

  const draftResult = getScopedFormDraft(conversationId, site.id);
  if (draftResult.status !== "FOUND") {
    return contextFailure(
      draftResult.status,
      draftResult.status === "FORM_DRAFT_EXPIRED"
        ? "The current form draft expired. Prepare a new draft before filling."
        : "There is no active form draft to fill.",
    );
  }
  const draft = draftResult.draft;

  try {
    const session = await getBrowserSession(site);
    const { page } = session;
    await settleVisiblePage(page);
    if (isAuthenticationRoute(page.url())) {
      return contextFailure("AUTH_EXPIRED", "The saved website session expired.", session.reused);
    }
    if (!isAllowedOrigin(page.url(), site.allowedOrigin)) {
      return contextFailure("UNEXPECTED_ORIGIN", "The browser is outside the connected website origin.", session.reused);
    }
    if (safeUrlForLog(page.url()) !== draft.pageUrl) {
      audit(conversationId, site.id, "FORM_FILL_CONTEXT_CHANGED");
      return contextFailure("FORM_CONTEXT_CHANGED", "The current page differs from the form draft. Nothing was filled.", session.reused);
    }
    const liveForm = await discoverLiveWebForm(page, site.id);
    if (!liveForm) {
      return contextFailure("FORM_NOT_AVAILABLE", "No single active visible form could be identified.", session.reused);
    }
    if (liveForm.descriptor.fingerprint !== draft.formFingerprint) {
      audit(conversationId, site.id, "FORM_FILL_CONTEXT_CHANGED");
      return contextFailure("FORM_CONTEXT_CHANGED", "The visible form changed after the draft was prepared. Nothing was filled.", session.reused);
    }

    const identities: FormFillFieldIdentity[] = [];
    const blocked: Array<{ field: string; reason: "sensitive" | "unsupported" }> = [];
    for (const value of draft.provided) {
      const draftField = draft.fields.find((field) => field.id === value.fieldId);
      if (!draftField) {
        return contextFailure("FIELD_NOT_AVAILABLE", `${value.field} is no longer part of the prepared form.`, session.reused);
      }
      if (isSensitiveFormField(draftField)) {
        blocked.push({ field: draftField.name, reason: "sensitive" });
        continue;
      }
      const identity = identityFor(draftField);
      if (!identity) {
        blocked.push({ field: draftField.name, reason: "unsupported" });
        continue;
      }
      identities.push(identity);
    }
    if (identities.length > MAX_FILL_FIELDS) {
      return contextFailure("FORM_FILL_LIMIT_EXCEEDED", `The fill plan exceeds the ${MAX_FILL_FIELDS}-field safety limit.`, session.reused);
    }
    if (identities.length === 0) {
      return {
        ...contextFailure("NO_SAFE_FIELDS_TO_FILL", "The draft has no supported ordinary fields to fill.", session.reused),
        blocked,
      };
    }
    const validation = await validateLivePlan({ liveForm, draft, identities });
    if (!validation.success) {
      return { ...contextFailure(validation.status, validation.message, session.reused), field: validation.field };
    }
    const fill = createPendingFormFill({ conversationId, siteId: site.id, draft, fields: identities });
    audit(conversationId, site.id, "FORM_FILL_PREPARED", {
      pendingActionId: fill.id,
      counts: { fields: identities.length, blocked: blocked.length },
    });
    return {
      success: true,
      status: "FORM_FILL_PENDING_CONFIRMATION",
      site: { id: site.id, name: site.name },
      risk: "write" as const,
      fill: {
        status: fill.status,
        fields: identities.map(safePlanField),
        blocked,
        requiredNotFilled: draft.missingRequired,
        sensitiveNotFilled: draft.missingRequired.filter((fieldName) => {
          const field = draft.fields.find((candidate) => candidate.name === fieldName);
          return field ? isSensitiveFormField(field) : false;
        }),
        expiresAt: fill.expiresAt,
      },
      browserReused: session.reused,
      browserMutation: false,
      submitted: false,
      message: `Ready to fill ${identities.length} ordinary field(s). Explicit confirmation is required. Nothing has been filled or submitted.`,
    };
  } catch (error) {
    if (error instanceof BrowserSessionError) return contextFailure(error.code, error.message);
    console.error("Form-fill preparation failed without browser mutation.");
    return contextFailure("FORM_FILL_PREPARATION_FAILED", "The fill plan could not be prepared safely. Nothing was filled.");
  }
}

export async function executeConnectedFormFill({
  siteId,
  context,
}: {
  siteId?: string;
  context: KinoToolContext;
}) {
  let requestedSite;
  if (siteId) {
    try {
      requestedSite = await getConnectedSite(siteId);
    } catch (error) {
      if (error instanceof ConnectionError) return contextFailure(error.code, error.message);
      throw error;
    }
  }
  const scoped = getScopedPendingFormFill(context.conversationId, requestedSite?.id);
  if (scoped.status !== "FOUND") {
    return contextFailure(
      scoped.status,
      scoped.status === "FORM_FILL_EXPIRED"
        ? "The pending form fill expired and was not executed."
        : "There is no single active pending form-fill operation.",
    );
  }
  const pending = scoped.fill;
  const confirmation = parseActionConfirmation({
    message: context.latestUserMessage,
    risk: "write",
  });
  if (!confirmation.explicit) {
    audit(context.conversationId, pending.siteId, "FORM_FILL_CONFIRMATION_REJECTED", { pendingActionId: pending.id });
    return contextFailure(confirmation.reason, "The latest user message is not an explicit confirmation. Nothing was filled.");
  }
  audit(context.conversationId, pending.siteId, "FORM_FILL_CONFIRMATION_ACCEPTED", { pendingActionId: pending.id });
  if (!transitionFormFill(pending.id, "pending", "executing")) {
    return contextFailure("NO_FORM_FILL_PENDING", "The pending form fill is no longer available.");
  }

  let site = requestedSite;
  try {
    site ??= await getConnectedSite(pending.siteId);
  } catch (error) {
    transitionFormFill(pending.id, "executing", "failed");
    if (error instanceof ConnectionError) return contextFailure(error.code, error.message);
    throw error;
  }

  let verifiedCount = 0;
  try {
    const draftResult = getScopedFormDraft(context.conversationId, site.id);
    if (draftResult.status !== "FOUND") {
      transitionFormFill(pending.id, "executing", "failed");
      audit(context.conversationId, site.id, "FORM_FILL_CONTEXT_CHANGED", { pendingActionId: pending.id });
      return contextFailure("FORM_CONTEXT_CHANGED", "The form draft changed after confirmation was requested. Nothing was filled.");
    }
    const draft = draftResult.draft;
    const session = await getBrowserSession(site);
    const { page } = session;
    await settleVisiblePage(page);
    if (
      isAuthenticationRoute(page.url()) ||
      !isAllowedOrigin(page.url(), site.allowedOrigin) ||
      formFillContextChanged(
        pending,
        draft,
        safeUrlForLog(page.url()),
        pending.formFingerprint,
      )
    ) {
      transitionFormFill(pending.id, "executing", "failed");
      audit(context.conversationId, site.id, "FORM_FILL_CONTEXT_CHANGED", { pendingActionId: pending.id });
      return contextFailure("FORM_CONTEXT_CHANGED", "The browser context changed after the fill was prepared. Nothing was filled.", session.reused);
    }
    const liveForm = await discoverLiveWebForm(page, site.id);
    if (!liveForm) {
      transitionFormFill(pending.id, "executing", "failed");
      return contextFailure("FORM_NOT_AVAILABLE", "The prepared form is no longer available. Nothing was filled.", session.reused);
    }
    if (liveForm.descriptor.fingerprint !== pending.formFingerprint) {
      transitionFormFill(pending.id, "executing", "failed");
      audit(context.conversationId, site.id, "FORM_FILL_CONTEXT_CHANGED", { pendingActionId: pending.id });
      return contextFailure("FORM_CONTEXT_CHANGED", "The form structure changed after preparation. Nothing was filled.", session.reused);
    }

    // Validate the complete plan before the first mutation.
    const validation = await validateLivePlan({ liveForm, draft, identities: pending.fields });
    if (!validation.success) {
      transitionFormFill(pending.id, "executing", "failed");
      return { ...contextFailure(validation.status, validation.message, session.reused), field: validation.field };
    }

    audit(context.conversationId, site.id, "FORM_FILL_STARTED", {
      pendingActionId: pending.id,
      counts: { fields: validation.fields.length },
    });
    const sequence = await executeValidatedFormFillPlan(validation.fields, {
      filled(planned) {
        audit(context.conversationId, site.id, "FORM_FIELD_FILLED", {
          pendingActionId: pending.id,
          fieldName: planned.identity.name,
          fieldType: planned.identity.fieldType,
        });
      },
      verified(planned) {
        audit(context.conversationId, site.id, "FORM_FIELD_VERIFIED", {
          pendingActionId: pending.id,
          fieldName: planned.identity.name,
          fieldType: planned.identity.fieldType,
        });
      },
      failed(planned) {
        audit(context.conversationId, site.id, "FORM_FIELD_FILL_FAILED", {
          pendingActionId: pending.id,
          fieldName: planned.identity.name,
          fieldType: planned.identity.fieldType,
        });
      },
    });
    verifiedCount = sequence.completed.length;
    const filled = sequence.completed.map(({ identity }) => ({
      field: identity.name,
      filled: true as const,
      verified: true as const,
    }));
    if (sequence.status === "partial") {
      transitionFormFill(pending.id, "executing", "failed", {
        verifiedCount,
        failedCount: 1,
      });
      audit(context.conversationId, site.id, "FORM_FILL_PARTIAL", {
        pendingActionId: pending.id,
        counts: {
          verified: verifiedCount,
          failed: 1,
          notAttempted: sequence.notAttempted.length,
        },
      });
      return {
        success: false,
        status: "FORM_FILL_PARTIAL",
        site: { id: site.id, name: site.name },
        filled,
        failed: [{ field: sequence.failed.identity.name }],
        notAttempted: sequence.notAttempted.map(({ identity }) => identity.name),
        browserReused: session.reused,
        browserMutation: verifiedCount > 0 || sequence.browserMutationPossible,
        submitted: false,
        message: "Form filling stopped after a field failed. The form was not submitted.",
      };
    }
    transitionFormFill(pending.id, "executing", "executed", { verifiedCount, failedCount: 0 });
    audit(context.conversationId, site.id, "FORM_FILL_COMPLETED", {
      pendingActionId: pending.id,
      counts: { verified: verifiedCount, failed: 0 },
    });
    return {
      success: true,
      status: "FORM_FILL_COMPLETED",
      site: { id: site.id, name: site.name },
      filled,
      notFilled: draft.missingRequired.map((fieldName) => {
        const field = draft.fields.find((candidate) => candidate.name === fieldName);
        return {
          field: fieldName,
          reason: field && isSensitiveFormField(field)
            ? "sensitive"
            : "required_not_provided",
        };
      }),
      browserReused: session.reused,
      browserMutation: true,
      submitted: false,
      message: `Filled and verified ${verifiedCount} ordinary field(s). The form was not submitted.`,
    };
  } catch (error) {
    transitionFormFill(pending.id, "executing", "failed", {
      verifiedCount,
      failedCount: verifiedCount > 0 ? 1 : 0,
    });
    if (error instanceof BrowserSessionError) return contextFailure(error.code, error.message);
    console.error("Form-fill execution failed; no field values were logged.");
    return {
      ...contextFailure(
        verifiedCount > 0 ? "FORM_FILL_PARTIAL" : "FORM_FILL_FAILED",
        verifiedCount > 0
          ? "Form filling stopped after a failure. The form was not submitted."
          : "The form could not be filled safely. Nothing was submitted.",
      ),
      verifiedCount,
    };
  }
}

export async function cancelConnectedFormFill({
  siteId,
  context,
}: {
  siteId?: string;
  context: KinoToolContext;
}) {
  if (context.source !== "chat" || !isExplicitCancellation(context.latestUserMessage)) {
    return contextFailure("CANCELLATION_NOT_EXPLICIT", "The latest user message is not an explicit cancellation.");
  }
  let canonicalSiteId: string | undefined;
  if (siteId) {
    try {
      canonicalSiteId = (await getConnectedSite(siteId)).id;
    } catch (error) {
      if (error instanceof ConnectionError) return contextFailure(error.code, error.message);
      throw error;
    }
  }
  const result = cancelScopedPendingFormFill(context.conversationId, canonicalSiteId);
  if (result.status !== "FOUND") {
    return contextFailure(result.status, "There is no single active pending form fill to cancel.");
  }
  audit(context.conversationId, result.fill.siteId, "FORM_FILL_CANCELLED", { pendingActionId: result.fill.id });
  return {
    success: true,
    status: "FORM_FILL_CANCELLED",
    browserMutation: false,
    submitted: false,
    message: "The pending form fill was cancelled. No fields were changed by it.",
  };
}
