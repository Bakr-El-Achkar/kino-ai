import { createHash } from "node:crypto";

import type { ActionAuditEvent } from "./action-types";

const MAX_AUDIT_EVENTS = 500;

type AuditProcess = NodeJS.Process & {
  __kinoWebActionAudit?: ActionAuditEvent[];
};

const auditProcess = process as AuditProcess;
const auditEvents = (auditProcess.__kinoWebActionAudit ??= []);

export function recordActionAuditEvent(
  event: Omit<ActionAuditEvent, "timestamp" | "conversationRef"> & {
    timestamp?: string;
    conversationId?: string;
  },
) {
  const { conversationId, ...safeEvent } = event;
  auditEvents.push({
    ...safeEvent,
    timestamp: event.timestamp ?? new Date().toISOString(),
    conversationRef: conversationId
      ? createHash("sha256").update(conversationId).digest("hex").slice(0, 16)
      : undefined,
  });
  if (auditEvents.length > MAX_AUDIT_EVENTS) {
    auditEvents.splice(0, auditEvents.length - MAX_AUDIT_EVENTS);
  }
}

export function getActionAuditEvents() {
  return auditEvents.map((event) => ({ ...event }));
}
