type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function fieldNames(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(record(item)?.field) || text(item)).filter(Boolean);
}

export function formatFormFillToolResponse(toolResult: unknown) {
  const wrapper = record(toolResult);
  const result = record(wrapper?.result) ?? wrapper;
  if (!result) return "The form-fill operation could not be verified. The form was not submitted.";
  const status = text(result.status);
  if (result.success === false) {
    if (status === "FORM_FILL_PARTIAL") {
      const filled = fieldNames(result.filled);
      const failed = fieldNames(result.failed);
      const notAttempted = fieldNames(result.notAttempted);
      const lines = ["Form filling stopped after a field failed."];
      if (filled.length) lines.push("", "Filled and verified:", ...filled.map((field) => `- ${field}`));
      if (failed.length) lines.push("", "Failed:", ...failed.map((field) => `- ${field}`));
      if (notAttempted.length) lines.push("", "Not attempted:", ...notAttempted.map((field) => `- ${field}`));
      lines.push("", "The form has NOT been submitted.");
      return lines.join("\n");
    }
    return `${text(result.message) || "The form-fill operation was safely rejected."} The form has NOT been submitted.`;
  }
  if (status === "FORM_FILL_PENDING_CONFIRMATION") {
    const fill = record(result.fill);
    const fields = fieldNames(fill?.fields);
    const required = Array.isArray(fill?.requiredNotFilled)
      ? fill.requiredNotFilled.map(text).filter(Boolean)
      : [];
    const sensitive = new Set(
      Array.isArray(fill?.sensitiveNotFilled)
        ? fill.sensitiveNotFilled.map(text).filter(Boolean)
        : [],
    );
    const lines = [`Ready to fill ${fields.length} ordinary field${fields.length === 1 ? "" : "s"}:`];
    lines.push(...fields.map((field) => `- ${field}`));
    if (required.length) {
      lines.push(
        "",
        "Still required and not included:",
        ...required.map((field) => `- ${field}${sensitive.has(field) ? " — sensitive" : ""}`),
      );
      if (sensitive.size) lines.push("Sensitive required fields will not be touched.");
    }
    lines.push("", "Confirm to continue.", "Nothing has been filled or submitted yet.");
    return lines.join("\n");
  }
  if (status === "FORM_FILL_CANCELLED") {
    return "The pending form fill was cancelled. No fields were changed, and the form was not submitted.";
  }
  if (status === "FORM_FILL_COMPLETED") {
    const fields = fieldNames(result.filled);
    const notFilledItems = Array.isArray(result.notFilled) ? result.notFilled : [];
    const notFilled = notFilledItems
      .map((item) => {
        const value = record(item);
        const field = text(value?.field);
        if (!field) return "";
        return `${field}${value?.reason === "sensitive" ? " — sensitive" : " — not provided"}`;
      })
      .filter(Boolean);
    const lines = ["Filled and verified:", ...fields.map((field) => `- ${field}`)];
    if (notFilled.length) {
      lines.push("", "Not filled:", ...notFilled.map((field) => `- ${field}`));
      if (notFilledItems.some((item) => record(item)?.reason === "sensitive")) {
        lines.push("Sensitive-field handling is not enabled yet.");
      }
    }
    lines.push("", "The form has NOT been submitted.");
    return lines.join("\n");
  }
  return `${text(result.message) || "The form-fill operation completed."} The form has NOT been submitted.`;
}
