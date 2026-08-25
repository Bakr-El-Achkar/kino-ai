import { recordActionAuditEvent } from "./audit";
import { BrowserSessionError, getBrowserSession } from "./browser-manager";
import { ConnectionError, getConnectedSite } from "./connections";
import { discoverCurrentWebForm } from "./form-discovery";
import {
  formDraftContextChanged,
  getScopedFormDraft,
  persistFormDraft,
} from "./form-drafts";
import { isSensitiveFormField, matchFormField } from "./form-matcher";
import type {
  FormDraftFieldValue,
  FormDraftIssue,
  FormDraftStatus,
  WebFormDescriptor,
} from "./form-types";
import { generateSafeTestValue, validateFormValue } from "./form-validation";
import {
  isAllowedOrigin,
  isAuthenticationRoute,
  safeUrlForLog,
  settleVisiblePage,
} from "./page-safety";

export type RequestedFormValue = {
  field: string;
  value: string | number | boolean;
};

function responseMessage(status: FormDraftStatus, missing: number, issues: number) {
  if (status === "DRAFT_READY") {
    return "The form draft is ready for review. Nothing has been entered or submitted.";
  }
  if (status === "DRAFT_INVALID") {
    return `The form draft has ${issues} mapping or validation issue(s). Nothing has been entered or submitted.`;
  }
  return `The form draft is incomplete and still has ${missing} required field(s). Nothing has been entered or submitted.`;
}

function safeFormSchema(form: WebFormDescriptor) {
  return {
    name: form.formName,
    scope: form.scope,
    fields: form.fields.map((field) => ({
      id: field.id,
      name: field.name,
      role: field.role,
      fieldType: field.fieldType,
      required: field.required,
      disabled: field.disabled,
      readonly: field.readonly,
      options: field.options,
      constraints: field.constraints,
      sensitive: isSensitiveFormField(field),
    })),
    submitControls: form.submitControls,
  };
}

export async function prepareConnectedFormDraft({
  conversationId,
  siteId,
  values,
  generateTestData = false,
}: {
  conversationId: string;
  siteId?: string;
  values: RequestedFormValue[];
  generateTestData?: boolean;
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

  const existingResult = getScopedFormDraft(conversationId, site.id);
  const existing = existingResult.status === "FOUND" ? existingResult.draft : undefined;

  try {
    const session = await getBrowserSession(site);
    const { page } = session;
    await settleVisiblePage(page);
    const currentUrl = safeUrlForLog(page.url());
    if (isAuthenticationRoute(page.url())) {
      return { success: false, status: "AUTH_EXPIRED", message: "The saved website session expired." };
    }
    if (!isAllowedOrigin(page.url(), site.allowedOrigin)) {
      return { success: false, status: "UNEXPECTED_ORIGIN", message: "The browser is outside the connected website origin." };
    }
    if (existing && formDraftContextChanged(existing, currentUrl)) {
      recordActionAuditEvent({
        conversationId,
        siteId: site.id,
        status: "FORM_CONTEXT_CHANGED",
      });
      return {
        success: false,
        status: "FORM_CONTEXT_CHANGED",
        message: "The current page changed after the form draft was prepared. Nothing was entered.",
        browserReused: session.reused,
      };
    }

    const form = await discoverCurrentWebForm(page, site.id);
    if (!form) {
      return {
        success: false,
        status: "FORM_NOT_AVAILABLE",
        message: "No single active visible form could be identified on the current page.",
        browserReused: session.reused,
      };
    }
    recordActionAuditEvent({
      conversationId,
      siteId: site.id,
      status: "FORM_DISCOVERED",
      counts: { fields: form.fields.length, submitControls: form.submitControls.length },
    });
    if (existing && formDraftContextChanged(existing, currentUrl, form.fingerprint)) {
      recordActionAuditEvent({
        conversationId,
        siteId: site.id,
        status: "FORM_CONTEXT_CHANGED",
      });
      return {
        success: false,
        status: "FORM_CONTEXT_CHANGED",
        message: "The visible form structure changed after the draft was prepared. Nothing was entered.",
        browserReused: session.reused,
      };
    }

    const provided = new Map<string, FormDraftFieldValue>();
    for (const item of existing?.provided ?? []) {
      if (form.fields.some((field) => field.id === item.fieldId)) {
        provided.set(item.fieldId, item);
      }
    }
    const issues: FormDraftIssue[] = [];
    for (const requested of values) {
      const match = matchFormField(requested.field, form.fields);
      if (match.status === "FIELD_NOT_FOUND") {
        issues.push({
          requestedField: requested.field,
          code: match.status,
          message: `No visible form field matches ${requested.field}.`,
        });
        continue;
      }
      if (match.status === "FIELD_AMBIGUOUS") {
        issues.push({
          requestedField: requested.field,
          code: match.status,
          candidates: match.candidates,
          message: `${requested.field} matches multiple visible fields.`,
        });
        recordActionAuditEvent({
          conversationId,
          siteId: site.id,
          fieldName: requested.field,
          status: "FORM_FIELD_AMBIGUOUS",
        });
        continue;
      }
      const { field } = match;
      if (isSensitiveFormField(field)) {
        issues.push({
          requestedField: requested.field,
          field: field.name,
          code: "UNSUPPORTED_SENSITIVE_FIELD",
          message: `${field.name} is a sensitive field and cannot be drafted in Step 10A.`,
        });
        recordActionAuditEvent({
          conversationId,
          siteId: site.id,
          fieldName: field.name,
          status: "FORM_VALUE_REJECTED",
        });
        continue;
      }
      const validation = validateFormValue(field, requested.value);
      if (!validation.valid) {
        issues.push({
          requestedField: requested.field,
          field: field.name,
          code: "INVALID_VALUE",
          message: validation.message,
        });
        recordActionAuditEvent({
          conversationId,
          siteId: site.id,
          fieldName: field.name,
          status: "FORM_VALUE_REJECTED",
        });
        continue;
      }
      provided.set(field.id, {
        fieldId: field.id,
        field: field.name,
        fieldType: field.fieldType,
        value: validation.value,
        source: "user",
      });
      recordActionAuditEvent({
        conversationId,
        siteId: site.id,
        fieldName: field.name,
        status: "FORM_FIELD_MAPPED",
      });
    }

    if (generateTestData) {
      for (const field of form.fields.filter(
        (candidate) => candidate.required && !provided.has(candidate.id),
      )) {
        if (isSensitiveFormField(field)) {
          issues.push({
            requestedField: field.name,
            field: field.name,
            code: "UNSUPPORTED_SENSITIVE_FIELD",
            message: `${field.name} is sensitive, so test data was not generated for it.`,
          });
          recordActionAuditEvent({
            conversationId,
            siteId: site.id,
            fieldName: field.name,
            status: "FORM_VALUE_REJECTED",
          });
          continue;
        }
        const generated = generateSafeTestValue(field);
        if (!generated.valid) {
          issues.push({
            requestedField: field.name,
            field: field.name,
            code: "INVALID_VALUE",
            message: generated.message,
          });
          continue;
        }
        provided.set(field.id, {
          fieldId: field.id,
          field: field.name,
          fieldType: field.fieldType,
          value: generated.value,
          source: "generated_test",
        });
        recordActionAuditEvent({
          conversationId,
          siteId: site.id,
          fieldName: field.name,
          status: "FORM_FIELD_MAPPED",
        });
      }
    }

    const providedValues = Array.from(provided.values());
    const missingRequiredFields = form.fields.filter(
      (field) => field.required && !provided.has(field.id),
    );
    const missingRequired = missingRequiredFields.map((field) => field.name);
    const sensitiveMissing = missingRequiredFields
      .filter(isSensitiveFormField)
      .map((field) => field.name);
    const status: FormDraftStatus =
      issues.length > 0
        ? "DRAFT_INVALID"
        : missingRequired.length > 0
          ? "DRAFT_INCOMPLETE"
          : "DRAFT_READY";
    const draft = persistFormDraft({
      conversationId,
      siteId: site.id,
      form,
      provided: providedValues,
      missingRequired,
      issues,
      status,
      existing,
    });
    recordActionAuditEvent({
      conversationId,
      siteId: site.id,
      status: existing ? "FORM_DRAFT_UPDATED" : "FORM_DRAFT_CREATED",
      counts: { provided: providedValues.length, missingRequired: missingRequired.length, issues: issues.length },
    });
    recordActionAuditEvent({
      conversationId,
      siteId: site.id,
      status:
        status === "DRAFT_READY"
          ? "FORM_DRAFT_READY"
          : status === "DRAFT_INVALID"
            ? "FORM_DRAFT_INVALID"
            : "FORM_DRAFT_INCOMPLETE",
      counts: { provided: providedValues.length, missingRequired: missingRequired.length, issues: issues.length },
    });
    return {
      success: true,
      status,
      site: { id: site.id, name: site.name },
      form: safeFormSchema(form),
      draft: {
        id: draft.id,
        status,
        provided: providedValues,
        missingRequired,
        sensitiveMissing,
        issues,
        optionalFields: form.fields.filter((field) => !field.required).map((field) => field.name),
        expiresAt: draft.expiresAt,
      },
      browserReused: session.reused,
      browserMutation: false,
      submitted: false,
      message: responseMessage(status, missingRequired.length, issues.length),
    };
  } catch (error) {
    if (error instanceof BrowserSessionError) {
      return { success: false, status: error.code, message: error.message };
    }
    console.error(
      "Web Agent form draft error:",
      error instanceof Error ? error.message : "Unknown form draft error.",
    );
    return {
      success: false,
      status: "FORM_DISCOVERY_ERROR",
      message: "The current form could not be safely inspected. Nothing was entered.",
    };
  }
}
