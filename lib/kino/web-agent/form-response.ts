type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function displayedValue(value: unknown) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "[unsupported value]";
}

export function formatFormDraftToolResponse(toolResult: unknown) {
  const wrapper = record(toolResult);
  const result = record(wrapper?.result) ?? wrapper;
  if (!result) {
    return "The current form could not be safely inspected. Nothing has been entered or submitted.";
  }
  if (result.success === false) {
    const status = text(result.status);
    if (status === "FORM_CONTEXT_CHANGED") {
      return "The form draft was not updated because the current page or visible form changed. Reopen the intended form and prepare a new draft. Nothing has been entered or submitted.";
    }
    if (status === "FORM_NOT_AVAILABLE") {
      return "No single active visible form could be identified on the current page. Nothing has been entered or submitted.";
    }
    return (
      (text(result.message) || "The form draft could not be prepared.") +
      " Nothing has been entered or submitted."
    );
  }

  const form = record(result.form);
  const draft = record(result.draft);
  const lines: string[] = [];
  const provided = Array.isArray(draft?.provided) ? draft.provided : [];
  const fields = Array.isArray(form?.fields) ? form.fields : [];
  if (provided.length === 0) {
    const formName = text(form?.name);
    lines.push(formName ? "Form: " + formName : "Current visible form:");
    for (const item of fields) {
      const field = record(item);
      if (!field) continue;
      const name = text(field.name);
      const fieldType = text(field.fieldType) || "unknown";
      const required = field.required === true ? ", required" : ", optional";
      const constraints = record(field.constraints);
      const minLength =
        typeof constraints?.minLength === "number"
          ? ", minimum " + constraints.minLength + " characters"
          : "";
      if (name) {
        lines.push("- " + name + " (" + fieldType + required + minLength + ")");
      }
    }
    const submitControls = Array.isArray(form?.submitControls)
      ? form.submitControls
      : [];
    const submitNames = submitControls
      .map((item) => text(record(item)?.name))
      .filter(Boolean);
    if (submitNames.length > 0) {
      lines.push(
        "Potential submit control" +
          (submitNames.length === 1 ? "" : "s") +
          ": " +
          submitNames.join(", "),
      );
    }
  } else {
    lines.push("Draft updated.", "", "Prepared:");
  }

  if (provided.length > 0) {
    for (const item of provided) {
      const value = record(item);
      if (!value) continue;
      const field = text(value.field);
      const source =
        value.source === "generated_test" ? "generated test" : "user";
      if (field) {
        lines.push(
          "- " +
            field +
            ": " +
            displayedValue(value.value) +
            " (" +
            source +
            ")",
        );
      }
    }
  }
  const missingRequired = Array.isArray(draft?.missingRequired)
    ? draft.missingRequired.map(text).filter(Boolean)
    : [];
  if (missingRequired.length > 0) {
    lines.push("", "Still required:");
    for (const field of missingRequired) lines.push("- " + field);
  }
  const sensitiveMissing = Array.isArray(draft?.sensitiveMissing)
    ? draft.sensitiveMissing.map(text).filter(Boolean)
    : [];
  if (sensitiveMissing.length === 1) {
    lines.push(
      "",
      sensitiveMissing[0] +
        " is sensitive and has not been stored or generated.",
    );
  } else if (sensitiveMissing.length > 1) {
    lines.push(
      "",
      sensitiveMissing.join(", ") +
        " are sensitive and have not been stored or generated.",
    );
  }
  const issues = Array.isArray(draft?.issues) ? draft.issues : [];
  if (issues.length > 0) {
    lines.push("Issues:");
    for (const item of issues) {
      const issue = record(item);
      const message = text(issue?.message);
      if (message) lines.push("- " + message);
    }
  }
  const status = text(draft?.status) || text(result.status) || "unknown";
  lines.push("", "Draft status: " + status + ".");
  lines.push("Nothing has been entered or submitted yet.");
  return lines.join("\n");
}
