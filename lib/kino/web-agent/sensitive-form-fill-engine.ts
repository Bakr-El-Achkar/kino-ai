import { isExplicitCancellation, parseActionConfirmation } from "./action-confirmation";
import { recordActionAuditEvent } from "./audit";
import { BrowserSessionError, getBrowserSession } from "./browser-manager";
import { ConnectionError, getConnectedSite } from "./connections";
import {
  cancelSensitiveFormFillRequest,
  createSensitiveFormFillRequest,
  getExecutingSensitiveValue,
  getSensitiveFormFillRequest,
  settleSensitiveFormFill,
  stageSensitiveFormValue,
  transitionSensitiveFormFill,
} from "./ephemeral-secrets";
import { discoverLiveWebForm, type LiveWebForm } from "./form-discovery";
import { isSensitiveFormField, matchFormField, normalizeFormFieldName } from "./form-matcher";
import type {
  SensitiveFormFieldIdentity,
  SensitiveFormFillMetadata,
  WebFormField,
} from "./form-types";
import { classifySensitiveFillEligibility } from "./sensitive-field-policy";
import { fillSensitiveField, verifySensitiveField } from "./sensitive-form-mutation";
import {
  isAllowedOrigin,
  isAuthenticationRoute,
  safeUrlForLog,
  settleVisiblePage,
} from "./page-safety";
import type { KinoToolContext } from "../tools/types";

function audit(
  conversationId: string,
  siteId: string,
  fieldName: string,
  status: Parameters<typeof recordActionAuditEvent>[0]["status"],
) {
  recordActionAuditEvent({
    conversationId,
    siteId,
    fieldName,
    risk: "write",
    status,
  });
}

function safeFailure(status: string, message: string, browserReused?: boolean) {
  return {
    success: false as const,
    status,
    message,
    browserReused,
    browserMutation: false,
    submitted: false,
  };
}

function identityFor(field: WebFormField): SensitiveFormFieldIdentity | null {
  const eligibility = classifySensitiveFillEligibility(field);
  if (!eligibility.eligible) return null;
  if (!["password", "text", "tel", "number"].includes(field.fieldType)) return null;
  return {
    fieldFingerprint: field.id,
    name: field.name,
    role: field.role,
    fieldType: field.fieldType as SensitiveFormFieldIdentity["fieldType"],
    required: field.required,
    constraints: field.constraints
      ? {
          minLength: field.constraints.minLength,
          maxLength: field.constraints.maxLength,
        }
      : undefined,
  };
}

function rediscoverSensitiveField(request: SensitiveFormFillMetadata, form: LiveWebForm) {
  const matches = form.fields.filter(
    ({ field }) =>
      field.id === request.field.fieldFingerprint &&
      normalizeFormFieldName(field.name) === normalizeFormFieldName(request.field.name) &&
      field.role === request.field.role &&
      field.fieldType === request.field.fieldType,
  );
  if (matches.length === 0) return { status: "FIELD_NOT_AVAILABLE" as const };
  if (matches.length > 1) return { status: "FIELD_AMBIGUOUS" as const };
  const live = matches[0];
  if (
    !isSensitiveFormField(live.field) ||
    !classifySensitiveFillEligibility(live.field).eligible
  ) {
    return { status: "SENSITIVE_FIELD_NOT_SUPPORTED" as const };
  }
  return { status: "MATCHED" as const, live };
}

async function revalidateSensitiveContext({
  request,
  conversationId,
}: {
  request: SensitiveFormFillMetadata;
  conversationId: string;
}) {
  let site;
  try {
    site = await getConnectedSite(request.siteId);
  } catch (error) {
    if (error instanceof ConnectionError) {
      return { success: false as const, result: safeFailure(error.code, error.message) };
    }
    throw error;
  }
  const session = await getBrowserSession(site);
  const { page } = session;
  await settleVisiblePage(page);
  if (isAuthenticationRoute(page.url())) {
    return { success: false as const, result: safeFailure("AUTH_EXPIRED", "The saved website session expired.", session.reused) };
  }
  if (!isAllowedOrigin(page.url(), site.allowedOrigin)) {
    return { success: false as const, result: safeFailure("UNEXPECTED_ORIGIN", "The browser is outside the connected website origin.", session.reused) };
  }
  if (safeUrlForLog(page.url()) !== request.pageUrl) {
    audit(conversationId, site.id, request.field.name, "SENSITIVE_FILL_FAILED");
    return { success: false as const, result: safeFailure("FORM_CONTEXT_CHANGED", "The current page changed. The sensitive value was discarded.", session.reused) };
  }
  const form = await discoverLiveWebForm(page, site.id);
  if (!form) {
    return { success: false as const, result: safeFailure("FORM_NOT_AVAILABLE", "The prepared form is no longer available.", session.reused) };
  }
  if (form.descriptor.fingerprint !== request.formFingerprint) {
    audit(conversationId, site.id, request.field.name, "SENSITIVE_FILL_FAILED");
    return { success: false as const, result: safeFailure("FORM_CONTEXT_CHANGED", "The form structure changed. The sensitive value was discarded.", session.reused) };
  }
  const field = rediscoverSensitiveField(request, form);
  if (field.status !== "MATCHED") {
    return { success: false as const, result: safeFailure(field.status, "The sensitive field could not be uniquely and safely rediscovered.", session.reused) };
  }
  if (
    field.live.field.disabled ||
    field.live.field.readonly ||
    !(await field.live.locator.isVisible()) ||
    !(await field.live.locator.isEnabled())
  ) {
    return { success: false as const, result: safeFailure("FIELD_NOT_AVAILABLE", "The sensitive field is not safely editable.", session.reused) };
  }
  return { success: true as const, site, session, field: field.live };
}

function discardAfterFailure(
  conversationId: string,
  request: SensitiveFormFillMetadata,
) {
  const discarded = settleSensitiveFormFill(request.secureRequestId, "failed");
  audit(conversationId, request.siteId, request.field.name, "SENSITIVE_FILL_FAILED");
  if (discarded.secretDiscarded) {
    audit(conversationId, request.siteId, request.field.name, "SENSITIVE_VALUE_DISCARDED");
  }
}

export async function prepareSensitiveFormFill({
  conversationId,
  siteId,
  requestedField,
}: {
  conversationId: string;
  siteId?: string;
  requestedField?: string;
}) {
  let site;
  try {
    site = await getConnectedSite(siteId);
  } catch (error) {
    if (error instanceof ConnectionError) return safeFailure(error.code, error.message);
    throw error;
  }
  try {
    const session = await getBrowserSession(site);
    const { page } = session;
    await settleVisiblePage(page);
    if (isAuthenticationRoute(page.url())) return safeFailure("AUTH_EXPIRED", "The saved website session expired.", session.reused);
    if (!isAllowedOrigin(page.url(), site.allowedOrigin)) return safeFailure("UNEXPECTED_ORIGIN", "The browser is outside the connected website origin.", session.reused);
    const form = await discoverLiveWebForm(page, site.id);
    if (!form) return safeFailure("FORM_NOT_AVAILABLE", "No single active visible form could be identified.", session.reused);

    let selected: WebFormField | undefined;
    if (requestedField?.trim()) {
      const match = matchFormField(requestedField, form.descriptor.fields);
      if (match.status !== "MATCHED") {
        return safeFailure(match.status, "The requested sensitive field could not be uniquely identified.", session.reused);
      }
      selected = match.field;
    } else {
      const eligible = form.descriptor.fields.filter(
        (field) => classifySensitiveFillEligibility(field).eligible,
      );
      if (eligible.length === 0) {
        const blocked = form.descriptor.fields.some(
          (field) => isSensitiveFormField(field),
        );
        return safeFailure(
          blocked ? "SENSITIVE_FIELD_NOT_SUPPORTED" : "FIELD_NOT_AVAILABLE",
          blocked
            ? "The visible sensitive fields are not eligible for secure authentication-secret filling."
            : "No eligible sensitive authentication field is visible.",
          session.reused,
        );
      }
      if (eligible.length !== 1) {
        return safeFailure("FIELD_AMBIGUOUS", "Multiple eligible sensitive fields are visible. Specify the intended field.", session.reused);
      }
      selected = eligible[0];
    }

    const eligibility = classifySensitiveFillEligibility(selected);
    if (!eligibility.eligible) {
      return safeFailure(
        isSensitiveFormField(selected) ? "SENSITIVE_FIELD_NOT_SUPPORTED" : "FIELD_NOT_SENSITIVE",
        "The requested field is not an eligible authentication-secret field for Step 10B.2.",
        session.reused,
      );
    }
    const identity = identityFor(selected);
    const live = form.fields.filter(({ field }) => field.id === selected.id);
    if (!identity || live.length !== 1) {
      return safeFailure("FIELD_AMBIGUOUS", "The sensitive field could not be uniquely identified.", session.reused);
    }
    if (
      selected.disabled ||
      selected.readonly ||
      !(await live[0].locator.isVisible()) ||
      !(await live[0].locator.isEnabled())
    ) {
      return safeFailure("FIELD_NOT_AVAILABLE", "The sensitive field is not safely editable.", session.reused);
    }
    const request = createSensitiveFormFillRequest({
      conversationId,
      siteId: site.id,
      pageUrl: form.descriptor.pageUrl,
      formFingerprint: form.descriptor.fingerprint,
      field: identity,
    });
    audit(conversationId, site.id, identity.name, "SENSITIVE_FILL_REQUESTED");
    return {
      success: true as const,
      status: "SECURE_VALUE_REQUIRED",
      secureRequestId: request.secureRequestId,
      fieldName: identity.name,
      fieldType: identity.fieldType,
      required: identity.required,
      expiresInSeconds: Math.ceil(
        (new Date(request.expiresAt).getTime() - Date.now()) / 1_000,
      ),
      browserMutation: false,
      submitted: false,
      message: `${identity.name} is sensitive. Enter it using the dedicated secure field.`,
    };
  } catch (error) {
    if (error instanceof BrowserSessionError) return safeFailure(error.code, error.message);
    console.error("Sensitive form-fill preparation failed without receiving a sensitive value.");
    return safeFailure("SENSITIVE_FILL_PREPARATION_FAILED", "The secure field request could not be prepared.");
  }
}

export async function captureSensitiveFormValue({
  conversationId,
  secureRequestId,
  value,
}: {
  conversationId: string;
  secureRequestId: string;
  value: string;
}) {
  const lookup = getSensitiveFormFillRequest(conversationId, secureRequestId);
  if (lookup.status !== "FOUND") {
    if (lookup.status === "SENSITIVE_VALUE_EXPIRED") {
      audit(conversationId, lookup.request.siteId, lookup.request.field.name, "SENSITIVE_VALUE_EXPIRED");
      if (lookup.secretDiscarded) audit(conversationId, lookup.request.siteId, lookup.request.field.name, "SENSITIVE_VALUE_DISCARDED");
    }
    return safeFailure(lookup.status, "The secure field request is unavailable or expired.");
  }
  if (lookup.request.stage !== "awaiting_secure_value") {
    return safeFailure("SENSITIVE_VALUE_ALREADY_RECEIVED", "This secure request is no longer accepting a value.");
  }
  let validation;
  try {
    validation = await revalidateSensitiveContext({ request: lookup.request, conversationId });
  } catch (error) {
    if (error instanceof BrowserSessionError) validation = { success: false as const, result: safeFailure(error.code, error.message) };
    else throw error;
  }
  if (!validation.success) {
    discardAfterFailure(conversationId, lookup.request);
    return validation.result;
  }
  const staged = stageSensitiveFormValue({ conversationId, secureRequestId, value });
  if (staged.status !== "SENSITIVE_VALUE_STAGED") {
    return safeFailure(staged.status, "The sensitive value was rejected without being stored.");
  }
  audit(conversationId, lookup.request.siteId, lookup.request.field.name, "SECURE_VALUE_RECEIVED");
  return {
    success: true as const,
    status: "SENSITIVE_VALUE_RECEIVED",
    secureRequestId,
    fieldName: lookup.request.field.name,
    expiresInSeconds: Math.ceil(
      (new Date(staged.request.expiresAt).getTime() - Date.now()) / 1_000,
    ),
    browserMutation: false,
    submitted: false,
    message: `Sensitive value received securely for ${lookup.request.field.name}. It has not been stored persistently. Confirm to fill it.`,
  };
}

export async function executeSensitiveFormFill({
  context,
}: {
  context: KinoToolContext;
}) {
  const lookup = getSensitiveFormFillRequest(context.conversationId);
  if (lookup.status !== "FOUND") {
    if (lookup.status === "SENSITIVE_VALUE_EXPIRED") {
      audit(context.conversationId, lookup.request.siteId, lookup.request.field.name, "SENSITIVE_VALUE_EXPIRED");
      if (lookup.secretDiscarded) audit(context.conversationId, lookup.request.siteId, lookup.request.field.name, "SENSITIVE_VALUE_DISCARDED");
    }
    return safeFailure(lookup.status, "There is no active staged sensitive value. Enter it securely again.");
  }
  const request = lookup.request;
  if (request.stage === "executed") {
    return safeFailure("NO_SENSITIVE_VALUE_STAGED", "The sensitive field was already filled and the staged value was discarded.");
  }
  if (request.stage !== "awaiting_confirmation") {
    return safeFailure("NO_SENSITIVE_VALUE_STAGED", "No sensitive value is awaiting confirmation.");
  }
  const confirmation = parseActionConfirmation({
    message: context.latestUserMessage,
    risk: "write",
  });
  if (!confirmation.explicit) {
    audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_FILL_CONFIRMATION_REJECTED");
    return safeFailure(confirmation.reason, "The latest user message is not an explicit confirmation. Nothing was filled.");
  }
  audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_FILL_CONFIRMATION_ACCEPTED");
  if (!transitionSensitiveFormFill(request.secureRequestId, "awaiting_confirmation", "executing")) {
    return safeFailure("NO_SENSITIVE_VALUE_STAGED", "The staged sensitive value is no longer available.");
  }

  try {
    const validation = await revalidateSensitiveContext({ request, conversationId: context.conversationId });
    if (!validation.success) {
      discardAfterFailure(context.conversationId, request);
      return validation.result;
    }
    audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_FILL_STARTED");
    const secret = getExecutingSensitiveValue(context.conversationId, request.secureRequestId);
    if (secret === null) {
      discardAfterFailure(context.conversationId, request);
      return safeFailure("NO_SENSITIVE_VALUE_STAGED", "The staged sensitive value is no longer available.");
    }
    let filled = false;
    let verified = false;
    try {
      await fillSensitiveField(validation.field.locator, secret);
      filled = true;
      audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_FIELD_FILLED");
      verified = await verifySensitiveField(validation.field.locator, secret);
    } catch {
      const discarded = settleSensitiveFormFill(
        request.secureRequestId,
        "failed",
        { filled, verified },
      );
      if (discarded.secretDiscarded) {
        audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_VALUE_DISCARDED");
      }
      audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_FILL_FAILED");
      return safeFailure(
        "SENSITIVE_FILL_FAILED",
        "The sensitive field could not be filled safely. The value was discarded.",
        validation.session.reused,
      );
    }
    // JavaScript cannot guarantee zeroization; deleting the store reference is best-effort disposal.
    const discarded = settleSensitiveFormFill(
      request.secureRequestId,
      verified ? "executed" : "failed",
      { filled, verified },
    );
    if (discarded.secretDiscarded) {
      audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_VALUE_DISCARDED");
    }
    if (!verified) {
      audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_FILL_FAILED");
      return safeFailure("SENSITIVE_FILL_FAILED", "The sensitive field could not be verified. The value was discarded.", validation.session.reused);
    }
    audit(context.conversationId, request.siteId, request.field.name, "SENSITIVE_FIELD_VERIFIED");
    return {
      success: true as const,
      status: "SENSITIVE_FILL_COMPLETED",
      site: { id: validation.site.id, name: validation.site.name },
      field: request.field.name,
      filled: true,
      verified: true,
      sensitiveValueDiscarded: true,
      browserMutation: true,
      submitted: false,
      message: `${request.field.name} was filled and verified. The sensitive value was discarded. The form was not submitted.`,
    };
  } catch (error) {
    discardAfterFailure(context.conversationId, request);
    if (error instanceof BrowserSessionError) return safeFailure(error.code, error.message);
    console.error("Sensitive form-fill execution failed; no sensitive value was logged.");
    return safeFailure("SENSITIVE_FILL_FAILED", "The sensitive field could not be filled safely. The value was discarded.");
  }
}

export function cancelSensitiveFormFill({ context }: { context: KinoToolContext }) {
  if (context.source !== "chat" || !isExplicitCancellation(context.latestUserMessage)) {
    return safeFailure("CANCELLATION_NOT_EXPLICIT", "The latest user message is not an explicit cancellation.");
  }
  const cancelled = cancelSensitiveFormFillRequest(context.conversationId);
  if (cancelled.status !== "SENSITIVE_FILL_CANCELLED") {
    return safeFailure(cancelled.status, "There is no active sensitive fill to cancel.");
  }
  audit(context.conversationId, cancelled.request.siteId, cancelled.request.field.name, "SENSITIVE_FILL_CANCELLED");
  if (cancelled.secretDiscarded) {
    audit(context.conversationId, cancelled.request.siteId, cancelled.request.field.name, "SENSITIVE_VALUE_DISCARDED");
  }
  return {
    success: true as const,
    status: "SENSITIVE_FILL_CANCELLED",
    field: cancelled.request.field.name,
    sensitiveValueDiscarded: cancelled.secretDiscarded,
    browserMutation: false,
    submitted: false,
    message: "The sensitive fill was cancelled and any staged value was discarded. Nothing was filled or submitted.",
  };
}
