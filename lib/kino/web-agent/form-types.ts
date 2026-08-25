export type WebFormFieldType =
  | "text"
  | "email"
  | "password"
  | "tel"
  | "number"
  | "date"
  | "datetime"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "switch"
  | "unknown";

export type WebFormFieldConstraints = {
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  step?: number;
};

export type WebFormField = {
  id: string;
  role: string;
  name: string;
  fieldType: WebFormFieldType;
  controlKind?: "input" | "textarea" | "select" | "contenteditable" | "aria";
  required: boolean;
  disabled: boolean;
  readonly: boolean;
  options?: string[];
  constraints?: WebFormFieldConstraints;
};

export type WebFormSubmitControl = {
  role: "button";
  name: string;
  risk: "write";
};

export type WebFormDescriptor = {
  siteId: string;
  pageUrl: string;
  title?: string;
  formName?: string;
  scope: "dialog" | "form" | "group";
  fingerprint: string;
  fields: WebFormField[];
  submitControls: WebFormSubmitControl[];
};

export type FormDraftValueSource = "user" | "generated_test";

export type FormDraftFieldValue = {
  fieldId: string;
  field: string;
  fieldType: WebFormFieldType;
  value: string | number | boolean;
  source: FormDraftValueSource;
};

export type FormDraftStatus =
  | "DRAFT_READY"
  | "DRAFT_INCOMPLETE"
  | "DRAFT_INVALID";

export type FormDraftIssue = {
  requestedField: string;
  field?: string;
  code:
    | "FIELD_NOT_FOUND"
    | "FIELD_AMBIGUOUS"
    | "INVALID_VALUE"
    | "UNSUPPORTED_SENSITIVE_FIELD";
  message: string;
  candidates?: string[];
};

export type StoredFormDraft = {
  id: string;
  conversationScope: string;
  siteId: string;
  pageUrl: string;
  formFingerprint: string;
  formName?: string;
  fields: Array<Pick<WebFormField, "id" | "name" | "role" | "fieldType" | "required">>;
  provided: FormDraftFieldValue[];
  missingRequired: string[];
  issues: FormDraftIssue[];
  status: FormDraftStatus | "expired" | "superseded";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};

export type SupportedFormFillFieldType = Extract<
  WebFormFieldType,
  | "text"
  | "email"
  | "tel"
  | "number"
  | "date"
  | "datetime"
  | "textarea"
  | "select"
  | "checkbox"
>;

export type FormFillFieldIdentity = {
  draftFieldId: string;
  name: string;
  role: string;
  fieldType: SupportedFormFillFieldType;
};

export type FormFillStatus =
  | "pending"
  | "executing"
  | "executed"
  | "cancelled"
  | "expired"
  | "failed"
  | "superseded";

export type StoredFormFill = {
  id: string;
  conversationScope: string;
  siteId: string;
  pageUrl: string;
  formFingerprint: string;
  draftId: string;
  draftUpdatedAt: string;
  risk: "write";
  fields: FormFillFieldIdentity[];
  status: FormFillStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  verifiedCount?: number;
  failedCount?: number;
};

export type SensitiveFormFieldIdentity = {
  fieldFingerprint: string;
  name: string;
  role: string;
  fieldType: Extract<WebFormFieldType, "password" | "text" | "tel" | "number">;
  required: boolean;
  constraints?: Pick<WebFormFieldConstraints, "minLength" | "maxLength">;
};

export type SensitiveFormFillStage =
  | "awaiting_secure_value"
  | "awaiting_confirmation"
  | "executing"
  | "executed"
  | "cancelled"
  | "expired"
  | "failed"
  | "superseded";

export type SensitiveFormFillMetadata = {
  secureRequestId: string;
  conversationScope: string;
  siteId: string;
  pageUrl: string;
  formFingerprint: string;
  field: SensitiveFormFieldIdentity;
  stage: SensitiveFormFillStage;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  filled?: boolean;
  verified?: boolean;
};
