import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import type {
  FormDraftFieldValue,
  FormDraftIssue,
  FormDraftStatus,
  StoredFormDraft,
  WebFormDescriptor,
} from "./form-types";

export const FORM_DRAFT_TTL_MILLISECONDS = 15 * 60 * 1_000;
const TERMINAL_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAX_STORED_DRAFTS = 100;
const STORE_PATH = resolve(process.cwd(), ".kino/runtime/form-drafts.json");

type FormDraftStore = { version: 1; drafts: StoredFormDraft[] };

function scopeHash(conversationId: string) {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 24);
}

function isStoredDraft(value: unknown): value is StoredFormDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.id === "string" &&
    typeof draft.conversationScope === "string" &&
    typeof draft.siteId === "string" &&
    typeof draft.pageUrl === "string" &&
    typeof draft.formFingerprint === "string" &&
    Array.isArray(draft.fields) &&
    Array.isArray(draft.provided) &&
    Array.isArray(draft.missingRequired) &&
    Array.isArray(draft.issues) &&
    typeof draft.status === "string" &&
    typeof draft.createdAt === "string" &&
    typeof draft.updatedAt === "string" &&
    typeof draft.expiresAt === "string"
  );
}

function loadDrafts() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<FormDraftStore>;
    return Array.isArray(parsed.drafts) ? parsed.drafts.filter(isStoredDraft) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("Form draft runtime store could not be read; using an empty safe state.");
    return [];
  }
}

function saveDrafts(drafts: StoredFormDraft[]) {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const retained = drafts
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_STORED_DRAFTS);
  const temporaryPath = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, drafts: retained }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    renameSync(temporaryPath, STORE_PATH);
  } finally {
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function expireAndCleanup(drafts: StoredFormDraft[], now: Date) {
  for (const draft of drafts) {
    if (
      !["expired", "superseded"].includes(draft.status) &&
      new Date(draft.expiresAt).getTime() <= now.getTime()
    ) {
      draft.status = "expired";
    }
  }
  return drafts.filter((draft) => {
    if (!["expired", "superseded"].includes(draft.status)) return true;
    return now.getTime() - new Date(draft.updatedAt).getTime() < TERMINAL_RETENTION_MILLISECONDS;
  });
}

export type ScopedFormDraftResult =
  | { status: "FOUND"; draft: StoredFormDraft }
  | { status: "NO_FORM_DRAFT" }
  | { status: "FORM_DRAFT_EXPIRED"; draft: StoredFormDraft };

export function formDraftContextChanged(
  draft: Pick<StoredFormDraft, "pageUrl" | "formFingerprint">,
  pageUrl: string,
  formFingerprint?: string,
) {
  return (
    draft.pageUrl !== pageUrl ||
    (formFingerprint !== undefined && draft.formFingerprint !== formFingerprint)
  );
}

export function getScopedFormDraft(
  conversationId: string,
  siteId: string,
  now = new Date(),
): ScopedFormDraftResult {
  const drafts = loadDrafts();
  const scope = scopeHash(conversationId);
  const scoped = drafts
    .filter((draft) => draft.conversationScope === scope && draft.siteId === siteId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const changed = scoped.some(
    (draft) =>
      !["expired", "superseded"].includes(draft.status) &&
      new Date(draft.expiresAt).getTime() <= now.getTime(),
  );
  if (changed) saveDrafts(expireAndCleanup(drafts, now));
  const active = scoped.find((draft) => !["expired", "superseded"].includes(draft.status));
  if (active && new Date(active.expiresAt).getTime() > now.getTime()) {
    return { status: "FOUND", draft: active };
  }
  const latest = scoped[0];
  return latest && (latest.status === "expired" || new Date(latest.expiresAt).getTime() <= now.getTime())
    ? { status: "FORM_DRAFT_EXPIRED", draft: latest }
    : { status: "NO_FORM_DRAFT" };
}

export function persistFormDraft({
  conversationId,
  siteId,
  form,
  provided,
  missingRequired,
  issues,
  status,
  existing,
  now = new Date(),
}: {
  conversationId: string;
  siteId: string;
  form: WebFormDescriptor;
  provided: FormDraftFieldValue[];
  missingRequired: string[];
  issues: FormDraftIssue[];
  status: FormDraftStatus;
  existing?: StoredFormDraft;
  now?: Date;
}) {
  const drafts = expireAndCleanup(loadDrafts(), now);
  const scope = scopeHash(conversationId);
  for (const draft of drafts) {
    if (
      draft.conversationScope === scope &&
      draft.siteId === siteId &&
      !["expired", "superseded"].includes(draft.status) &&
      draft.id !== existing?.id
    ) {
      draft.status = "superseded";
    }
  }
  const draft: StoredFormDraft = {
    id: existing?.id ?? randomUUID(),
    conversationScope: scope,
    siteId,
    pageUrl: form.pageUrl,
    formFingerprint: form.fingerprint,
    formName: form.formName,
    fields: form.fields.map(({ id, name, role, fieldType, required }) => ({
      id,
      name,
      role,
      fieldType,
      required,
    })),
    provided,
    missingRequired,
    issues,
    status,
    createdAt: existing?.createdAt ?? now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + FORM_DRAFT_TTL_MILLISECONDS).toISOString(),
  };
  const existingIndex = drafts.findIndex((candidate) => candidate.id === draft.id);
  if (existingIndex >= 0) drafts[existingIndex] = draft;
  else drafts.push(draft);
  saveDrafts(drafts);
  console.log("FORM_DRAFT_SAVED", {
    scope,
    siteId,
    draftId: draft.id,
    status,
    providedCount: provided.length,
    missingRequiredCount: missingRequired.length,
    issueCount: issues.length,
    expiresAt: draft.expiresAt,
  });
  return draft;
}

export function getFormDraftRuntimeSummary(conversationId: string, now = new Date()) {
  const scope = scopeHash(conversationId);
  const loaded = loadDrafts();
  const changed = loaded.some(
    (draft) =>
      !["expired", "superseded"].includes(draft.status) &&
      new Date(draft.expiresAt).getTime() <= now.getTime(),
  );
  const drafts = expireAndCleanup(loaded, now);
  if (changed) saveDrafts(drafts);
  const active = drafts
    .filter(
      (draft) =>
        draft.conversationScope === scope &&
        !["expired", "superseded"].includes(draft.status),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!active) return { exists: false } as const;
  return {
    exists: true,
    siteId: active.siteId,
    status: active.status,
    missingRequired: active.missingRequired.length,
    expiresInSeconds: Math.max(
      0,
      Math.ceil((new Date(active.expiresAt).getTime() - now.getTime()) / 1_000),
    ),
  } as const;
}
