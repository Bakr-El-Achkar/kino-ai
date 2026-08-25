import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

import { conversationScopeHash } from "./pending-actions.ts";
import type {
  FormFillFieldIdentity,
  FormFillStatus,
  StoredFormDraft,
  StoredFormFill,
} from "./form-types";

export const FORM_FILL_TTL_MILLISECONDS = 5 * 60 * 1_000;
const TERMINAL_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAX_STORED_FILLS = 100;
const STORE_PATH = resolve(process.cwd(), ".kino/runtime/pending-form-fills.json");

type FormFillStore = { version: 1; fills: StoredFormFill[] };

export type ScopedFormFillResult =
  | { status: "FOUND"; fill: StoredFormFill }
  | { status: "NO_FORM_FILL_PENDING" }
  | { status: "MULTIPLE_FORM_FILLS_PENDING" }
  | { status: "FORM_FILL_EXPIRED"; fill: StoredFormFill };

function isStoredFormFill(value: unknown): value is StoredFormFill {
  if (!value || typeof value !== "object") return false;
  const fill = value as Record<string, unknown>;
  return (
    typeof fill.id === "string" &&
    typeof fill.conversationScope === "string" &&
    typeof fill.siteId === "string" &&
    typeof fill.pageUrl === "string" &&
    typeof fill.formFingerprint === "string" &&
    typeof fill.draftId === "string" &&
    typeof fill.draftUpdatedAt === "string" &&
    fill.risk === "write" &&
    Array.isArray(fill.fields) &&
    typeof fill.status === "string" &&
    typeof fill.createdAt === "string" &&
    typeof fill.updatedAt === "string" &&
    typeof fill.expiresAt === "string"
  );
}

function loadFills() {
  try {
    const parsed = JSON.parse(readFileSync(STORE_PATH, "utf8")) as Partial<FormFillStore>;
    return Array.isArray(parsed.fills) ? parsed.fills.filter(isStoredFormFill) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    console.error("Pending form-fill store could not be read; using an empty safe state.");
    return [];
  }
}

function saveFills(fills: StoredFormFill[]) {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const retained = fills
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_STORED_FILLS);
  const temporaryPath = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporaryPath,
      `${JSON.stringify({ version: 1, fills: retained }, null, 2)}\n`,
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

function expire(fill: StoredFormFill, now: Date) {
  if (fill.status === "pending" && new Date(fill.expiresAt).getTime() <= now.getTime()) {
    fill.status = "expired";
    fill.updatedAt = now.toISOString();
    return true;
  }
  return false;
}

function cleanup(fills: StoredFormFill[], now: Date) {
  return fills.filter((fill) => {
    expire(fill, now);
    if (fill.status === "pending" || fill.status === "executing") return true;
    return now.getTime() - new Date(fill.updatedAt).getTime() < TERMINAL_RETENTION_MILLISECONDS;
  });
}

function scopedFills(fills: StoredFormFill[], conversationId: string, siteId?: string) {
  const scope = conversationScopeHash(conversationId);
  return fills
    .filter((fill) => fill.conversationScope === scope && (!siteId || fill.siteId === siteId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function createPendingFormFill({
  conversationId,
  siteId,
  draft,
  fields,
  now = new Date(),
}: {
  conversationId: string;
  siteId: string;
  draft: StoredFormDraft;
  fields: FormFillFieldIdentity[];
  now?: Date;
}) {
  const fills = cleanup(loadFills(), now);
  for (const fill of scopedFills(fills, conversationId, siteId)) {
    if (fill.status === "pending") {
      fill.status = "superseded";
      fill.updatedAt = now.toISOString();
    }
  }
  const fill: StoredFormFill = {
    id: randomUUID(),
    conversationScope: conversationScopeHash(conversationId),
    siteId,
    pageUrl: draft.pageUrl,
    formFingerprint: draft.formFingerprint,
    draftId: draft.id,
    draftUpdatedAt: draft.updatedAt,
    risk: "write",
    fields,
    status: "pending",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + FORM_FILL_TTL_MILLISECONDS).toISOString(),
  };
  fills.push(fill);
  saveFills(fills);
  return fill;
}

export function getScopedPendingFormFill(
  conversationId: string,
  siteId?: string,
  now = new Date(),
): ScopedFormFillResult {
  const fills = loadFills();
  const scoped = scopedFills(fills, conversationId, siteId);
  const changed = scoped.some((fill) => expire(fill, now));
  if (changed) saveFills(cleanup(fills, now));
  const active = scoped.filter((fill) => fill.status === "pending");
  if (active.length === 1) return { status: "FOUND", fill: active[0] };
  if (active.length > 1) return { status: "MULTIPLE_FORM_FILLS_PENDING" };
  const latest = scoped[0];
  return latest?.status === "expired"
    ? { status: "FORM_FILL_EXPIRED", fill: latest }
    : { status: "NO_FORM_FILL_PENDING" };
}

export function getLatestScopedFormFill(conversationId: string, now = new Date()) {
  const fills = loadFills();
  const scoped = scopedFills(fills, conversationId);
  const changed = scoped.some((fill) => expire(fill, now));
  if (changed) saveFills(cleanup(fills, now));
  return scoped[0] ?? null;
}

export function formFillContextChanged(
  fill: Pick<StoredFormFill, "draftId" | "draftUpdatedAt" | "pageUrl" | "formFingerprint">,
  draft: Pick<StoredFormDraft, "id" | "updatedAt">,
  pageUrl: string,
  formFingerprint: string,
) {
  return (
    fill.draftId !== draft.id ||
    fill.draftUpdatedAt !== draft.updatedAt ||
    fill.pageUrl !== pageUrl ||
    fill.formFingerprint !== formFingerprint
  );
}

export function transitionFormFill(
  id: string,
  expected: FormFillStatus,
  next: FormFillStatus,
  counts?: { verifiedCount?: number; failedCount?: number },
) {
  const fills = loadFills();
  const fill = fills.find((candidate) => candidate.id === id);
  if (!fill || fill.status !== expected) return false;
  fill.status = next;
  fill.updatedAt = new Date().toISOString();
  if (counts?.verifiedCount !== undefined) fill.verifiedCount = counts.verifiedCount;
  if (counts?.failedCount !== undefined) fill.failedCount = counts.failedCount;
  saveFills(fills);
  return true;
}

export function cancelScopedPendingFormFill(
  conversationId: string,
  siteId?: string,
  now = new Date(),
) {
  const result = getScopedPendingFormFill(conversationId, siteId, now);
  if (result.status !== "FOUND") return result;
  if (!transitionFormFill(result.fill.id, "pending", "cancelled")) {
    return { status: "NO_FORM_FILL_PENDING" } as const;
  }
  result.fill.status = "cancelled";
  return result;
}

export function getFormFillRuntimeSummary(conversationId: string, now = new Date()) {
  const fills = loadFills();
  const scoped = scopedFills(fills, conversationId);
  const changed = scoped.some((fill) => expire(fill, now));
  if (changed) saveFills(cleanup(fills, now));
  const latest = scoped[0];
  if (!latest) return { exists: false } as const;
  return {
    exists: true,
    siteId: latest.siteId,
    status: latest.status,
    fieldCount: latest.fields.length,
    verifiedCount: latest.verifiedCount ?? 0,
    failedCount: latest.failedCount ?? 0,
    expiresInSeconds:
      latest.status === "pending"
        ? Math.max(0, Math.ceil((new Date(latest.expiresAt).getTime() - now.getTime()) / 1_000))
        : undefined,
  } as const;
}
