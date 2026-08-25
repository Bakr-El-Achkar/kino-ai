type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function formatSensitiveFormFillResponse(toolResult: unknown) {
  const wrapper = record(toolResult);
  const result = record(wrapper?.result) ?? wrapper;
  if (!result) return "The sensitive-field operation could not be verified. The form was not submitted.";
  const status = text(result.status);
  const field = text(result.fieldName) || text(result.field) || "Sensitive field";
  if (result.success === false) {
    if (status === "NO_SENSITIVE_VALUE_STAGED" || status === "NO_SENSITIVE_FILL_REQUEST") {
      return "There is no active staged sensitive value. Provide it through the secure field again. The form has NOT been submitted.";
    }
    if (status === "SENSITIVE_VALUE_EXPIRED") {
      return "The staged sensitive value expired and was discarded. Provide it securely again. The form has NOT been submitted.";
    }
    return `${text(result.message) || "The sensitive-field operation was safely rejected."} The form has NOT been submitted.`;
  }
  if (status === "SECURE_VALUE_REQUIRED") {
    return `${field} is required. Because it is sensitive, enter it using the secure field. Nothing has been filled or submitted.`;
  }
  if (status === "SENSITIVE_FILL_CANCELLED") {
    return "The sensitive fill was cancelled and the staged value was discarded. Nothing was filled or submitted.";
  }
  if (status === "SENSITIVE_FILL_COMPLETED") {
    return `${field} was filled and verified. The sensitive value has been discarded.\n\nThe form has NOT been submitted.`;
  }
  return `${text(result.message) || "The sensitive-field operation completed."} The form has NOT been submitted.`;
}
