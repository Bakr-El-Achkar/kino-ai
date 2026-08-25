export type WebActionRisk = "read" | "write" | "critical";

export type WebActionRole =
  | "button"
  | "link"
  | "menuitem"
  | "checkbox"
  | "radio"
  | "switch"
  | "tab";

export type WebActionDestination =
  | "same-page"
  | "same-origin"
  | "external"
  | "unsafe"
  | "none";

export type WebActionCandidate = {
  id: string;
  role: WebActionRole;
  name: string;
  risk: WebActionRisk;
  reason: string;
  destination: WebActionDestination;
};

export type SafeActionFingerprint = {
  siteId: string;
  pageUrl: string;
  role: WebActionRole;
  accessibleName: string;
  risk: WebActionRisk;
};

export type PendingWebAction = {
  id: string;
  conversationScope: string;
  siteId: string;
  requestedIntent: string;
  matchedName: string;
  role: WebActionRole;
  risk: "write" | "critical";
  requiredConfirmationPhrase?: string;
  fingerprint: SafeActionFingerprint;
  createdAt: string;
  expiresAt: string;
  status: PendingWebActionStatus;
};

export type PendingWebActionStatus =
  | "pending"
  | "executing"
  | "executed"
  | "cancelled"
  | "expired"
  | "failed"
  | "superseded";

export type ActionMatchSuccess = {
  status: "MATCHED";
  candidate: WebActionCandidate;
};

export type ActionMatchFailure =
  | {
      status: "NO_ACTION_MATCH";
      candidates: string[];
    }
  | {
      status: "AMBIGUOUS_ACTION";
      candidates: string[];
    };

export type ActionMatchResult = ActionMatchSuccess | ActionMatchFailure;

export type ActionAuditEventType =
  | "ACTION_DISCOVERED"
  | "ACTION_PREPARED"
  | "ACTION_REJECTED_AMBIGUOUS"
  | "ACTION_REJECTED_NO_MATCH"
  | "ACTION_CONFIRMATION_ACCEPTED"
  | "ACTION_CONFIRMATION_REJECTED"
  | "ACTION_CANCELLED"
  | "ACTION_REVALIDATED"
  | "ACTION_EXECUTION_STARTED"
  | "ACTION_CONTROL_ACTIVATED"
  | "ACTION_VERIFIED"
  | "ACTION_VERIFICATION_UNCERTAIN"
  | "ACTION_EXECUTION_FAILED"
  | "ACTION_EXPIRED"
  | "ACTION_BLOCKED_CONTEXT_CHANGED"
  | "FORM_DISCOVERED"
  | "FORM_DRAFT_CREATED"
  | "FORM_DRAFT_UPDATED"
  | "FORM_FIELD_MAPPED"
  | "FORM_FIELD_AMBIGUOUS"
  | "FORM_VALUE_REJECTED"
  | "FORM_DRAFT_READY"
  | "FORM_DRAFT_INCOMPLETE"
  | "FORM_DRAFT_INVALID"
  | "FORM_CONTEXT_CHANGED"
  | "FORM_FILL_PREPARED"
  | "FORM_FILL_CONFIRMATION_ACCEPTED"
  | "FORM_FILL_CONFIRMATION_REJECTED"
  | "FORM_FILL_STARTED"
  | "FORM_FIELD_FILLED"
  | "FORM_FIELD_VERIFIED"
  | "FORM_FIELD_FILL_FAILED"
  | "FORM_FILL_COMPLETED"
  | "FORM_FILL_PARTIAL"
  | "FORM_FILL_CONTEXT_CHANGED"
  | "FORM_FILL_CANCELLED"
  | "SENSITIVE_FILL_REQUESTED"
  | "SECURE_VALUE_RECEIVED"
  | "SENSITIVE_FILL_CONFIRMATION_ACCEPTED"
  | "SENSITIVE_FILL_CONFIRMATION_REJECTED"
  | "SENSITIVE_FILL_STARTED"
  | "SENSITIVE_FIELD_FILLED"
  | "SENSITIVE_FIELD_VERIFIED"
  | "SENSITIVE_FILL_FAILED"
  | "SENSITIVE_FILL_CANCELLED"
  | "SENSITIVE_VALUE_EXPIRED"
  | "SENSITIVE_VALUE_DISCARDED";

export type ActionAuditEvent = {
  timestamp: string;
  conversationRef?: string;
  siteId: string;
  actionName?: string;
  risk?: WebActionRisk;
  role?: WebActionRole;
  pendingActionId?: string;
  fieldName?: string;
  fieldType?: string;
  counts?: Record<string, number>;
  verificationType?: string;
  status: ActionAuditEventType;
};
