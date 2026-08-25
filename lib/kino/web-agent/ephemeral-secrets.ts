import { randomUUID } from "node:crypto";

import { conversationScopeHash } from "./pending-actions.ts";
import type {
  SensitiveFormFieldIdentity,
  SensitiveFormFillMetadata,
  SensitiveFormFillStage,
} from "./form-types";

export const SENSITIVE_VALUE_TTL_MILLISECONDS = 3 * 60 * 1_000;
const TERMINAL_METADATA_TTL_MILLISECONDS = 15 * 60 * 1_000;

type SensitiveFormFillRecord = SensitiveFormFillMetadata & {
  secret?: string;
};

type SensitiveProcess = NodeJS.Process & {
  __kinoEphemeralSensitiveFormFills?: Map<string, SensitiveFormFillRecord>;
};

const sensitiveProcess = process as SensitiveProcess;
const records =
  (sensitiveProcess.__kinoEphemeralSensitiveFormFills ??= new Map<
    string,
    SensitiveFormFillRecord
  >());

const TERMINAL_STAGES = new Set<SensitiveFormFillStage>([
  "executed",
  "cancelled",
  "expired",
  "failed",
  "superseded",
]);

function safeMetadata(record: SensitiveFormFillRecord): SensitiveFormFillMetadata {
  return {
    secureRequestId: record.secureRequestId,
    conversationScope: record.conversationScope,
    siteId: record.siteId,
    pageUrl: record.pageUrl,
    formFingerprint: record.formFingerprint,
    field: {
      fieldFingerprint: record.field.fieldFingerprint,
      name: record.field.name,
      role: record.field.role,
      fieldType: record.field.fieldType,
      required: record.field.required,
      constraints: record.field.constraints
        ? {
            minLength: record.field.constraints.minLength,
            maxLength: record.field.constraints.maxLength,
          }
        : undefined,
    },
    stage: record.stage,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt,
    filled: record.filled,
    verified: record.verified,
  };
}

function removeSecret(record: SensitiveFormFillRecord) {
  const discarded = typeof record.secret === "string";
  delete record.secret;
  return discarded;
}

function expireRecord(record: SensitiveFormFillRecord, now: Date) {
  if (
    !TERMINAL_STAGES.has(record.stage) &&
    new Date(record.expiresAt).getTime() <= now.getTime()
  ) {
    const discarded = removeSecret(record);
    record.stage = "expired";
    record.updatedAt = now.toISOString();
    return discarded;
  }
  return false;
}

function cleanup(now: Date) {
  for (const [id, record] of records) {
    if (
      TERMINAL_STAGES.has(record.stage) &&
      now.getTime() - new Date(record.updatedAt).getTime() >=
        TERMINAL_METADATA_TTL_MILLISECONDS
    ) {
      removeSecret(record);
      records.delete(id);
    }
  }
}

function scopedRecords(conversationId: string) {
  const scope = conversationScopeHash(conversationId);
  return [...records.values()]
    .filter((record) => record.conversationScope === scope)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function createSensitiveFormFillRequest({
  conversationId,
  siteId,
  pageUrl,
  formFingerprint,
  field,
  now = new Date(),
  ttlMilliseconds = SENSITIVE_VALUE_TTL_MILLISECONDS,
}: {
  conversationId: string;
  siteId: string;
  pageUrl: string;
  formFingerprint: string;
  field: SensitiveFormFieldIdentity;
  now?: Date;
  ttlMilliseconds?: number;
}) {
  cleanup(now);
  for (const record of scopedRecords(conversationId)) {
    expireRecord(record, now);
    if (!TERMINAL_STAGES.has(record.stage)) {
      removeSecret(record);
      record.stage = "superseded";
      record.updatedAt = now.toISOString();
    }
  }
  const record: SensitiveFormFillRecord = {
    secureRequestId: randomUUID(),
    conversationScope: conversationScopeHash(conversationId),
    siteId,
    pageUrl,
    formFingerprint,
    field,
    stage: "awaiting_secure_value",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMilliseconds).toISOString(),
  };
  records.set(record.secureRequestId, record);
  return safeMetadata(record);
}

export type SensitiveRequestLookup =
  | { status: "FOUND"; request: SensitiveFormFillMetadata; secretDiscarded: boolean }
  | { status: "NO_SENSITIVE_FILL_REQUEST" }
  | { status: "SENSITIVE_VALUE_EXPIRED"; request: SensitiveFormFillMetadata; secretDiscarded: boolean };

export function getSensitiveFormFillRequest(
  conversationId: string,
  secureRequestId?: string,
  now = new Date(),
): SensitiveRequestLookup {
  cleanup(now);
  const scope = conversationScopeHash(conversationId);
  const record = secureRequestId
    ? records.get(secureRequestId)
    : scopedRecords(conversationId)[0];
  if (!record || record.conversationScope !== scope) {
    return { status: "NO_SENSITIVE_FILL_REQUEST" };
  }
  const secretDiscarded = expireRecord(record, now);
  const request = safeMetadata(record);
  return record.stage === "expired"
    ? { status: "SENSITIVE_VALUE_EXPIRED", request, secretDiscarded }
    : { status: "FOUND", request, secretDiscarded };
}

export function stageSensitiveFormValue({
  conversationId,
  secureRequestId,
  value,
  now = new Date(),
  ttlMilliseconds = SENSITIVE_VALUE_TTL_MILLISECONDS,
}: {
  conversationId: string;
  secureRequestId: string;
  value: string;
  now?: Date;
  ttlMilliseconds?: number;
}) {
  const lookup = getSensitiveFormFillRequest(conversationId, secureRequestId, now);
  if (lookup.status !== "FOUND") return lookup;
  const record = records.get(secureRequestId);
  if (!record || record.stage !== "awaiting_secure_value") {
    return { status: "SENSITIVE_VALUE_ALREADY_RECEIVED" as const, request: lookup.request };
  }
  if (value.length === 0) {
    return { status: "EMPTY_SENSITIVE_VALUE" as const, request: lookup.request };
  }
  const { minLength, maxLength } = record.field.constraints ?? {};
  if (minLength !== undefined && value.length < minLength) {
    return { status: "SENSITIVE_VALUE_CONSTRAINT_FAILED" as const, request: lookup.request };
  }
  if (maxLength !== undefined && value.length > maxLength) {
    return { status: "SENSITIVE_VALUE_CONSTRAINT_FAILED" as const, request: lookup.request };
  }
  record.secret = value;
  record.stage = "awaiting_confirmation";
  record.updatedAt = now.toISOString();
  record.expiresAt = new Date(now.getTime() + ttlMilliseconds).toISOString();
  return { status: "SENSITIVE_VALUE_STAGED" as const, request: safeMetadata(record) };
}

export function transitionSensitiveFormFill(
  secureRequestId: string,
  expected: SensitiveFormFillStage,
  next: SensitiveFormFillStage,
) {
  const record = records.get(secureRequestId);
  if (!record || record.stage !== expected) return false;
  record.stage = next;
  record.updatedAt = new Date().toISOString();
  return true;
}

export function getExecutingSensitiveValue(
  conversationId: string,
  secureRequestId: string,
) {
  const record = records.get(secureRequestId);
  if (
    !record ||
    record.conversationScope !== conversationScopeHash(conversationId) ||
    record.stage !== "executing" ||
    typeof record.secret !== "string"
  ) {
    return null;
  }
  return record.secret;
}

export function settleSensitiveFormFill(
  secureRequestId: string,
  stage: Extract<SensitiveFormFillStage, "executed" | "failed" | "cancelled">,
  result?: { filled?: boolean; verified?: boolean },
) {
  const record = records.get(secureRequestId);
  if (!record) return { found: false, secretDiscarded: false } as const;
  const secretDiscarded = removeSecret(record);
  record.stage = stage;
  record.updatedAt = new Date().toISOString();
  record.filled = result?.filled;
  record.verified = result?.verified;
  return { found: true, secretDiscarded } as const;
}

export function cancelSensitiveFormFillRequest(
  conversationId: string,
  secureRequestId?: string,
  now = new Date(),
) {
  const lookup = getSensitiveFormFillRequest(conversationId, secureRequestId, now);
  if (lookup.status !== "FOUND") return lookup;
  const record = records.get(lookup.request.secureRequestId);
  if (!record || TERMINAL_STAGES.has(record.stage)) {
    return { status: "NO_SENSITIVE_FILL_REQUEST" as const };
  }
  const secretDiscarded = removeSecret(record);
  record.stage = "cancelled";
  record.updatedAt = now.toISOString();
  return {
    status: "SENSITIVE_FILL_CANCELLED" as const,
    request: safeMetadata(record),
    secretDiscarded,
  };
}

export function getSensitiveFormFillRuntimeSummary(
  conversationId: string,
  now = new Date(),
) {
  const lookup = getSensitiveFormFillRequest(conversationId, undefined, now);
  if (lookup.status === "NO_SENSITIVE_FILL_REQUEST") return { exists: false } as const;
  const request = lookup.request;
  return {
    exists: true,
    secureRequestId: request.secureRequestId,
    siteId: request.siteId,
    stage: request.stage,
    fieldName: request.field.name,
    filled: request.filled ?? false,
    verified: request.verified ?? false,
    expiresInSeconds: TERMINAL_STAGES.has(request.stage)
      ? undefined
      : Math.max(
          0,
          Math.ceil((new Date(request.expiresAt).getTime() - now.getTime()) / 1_000),
        ),
  } as const;
}

export function sensitiveFormContextChanged(
  request: Pick<SensitiveFormFillMetadata, "pageUrl" | "formFingerprint" | "field">,
  live: {
    pageUrl: string;
    formFingerprint: string;
    fieldFingerprint: string;
    fieldName: string;
    role: string;
    fieldType: string;
  },
) {
  return (
    request.pageUrl !== live.pageUrl ||
    request.formFingerprint !== live.formFingerprint ||
    request.field.fieldFingerprint !== live.fieldFingerprint ||
    normalizeIdentity(request.field.name) !== normalizeIdentity(live.fieldName) ||
    request.field.role !== live.role ||
    request.field.fieldType !== live.fieldType
  );
}

function normalizeIdentity(value: string) {
  return value.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function clearEphemeralSensitiveStateForTests() {
  for (const record of records.values()) removeSecret(record);
  records.clear();
}
