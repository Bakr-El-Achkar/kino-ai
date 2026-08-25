import { randomBytes } from "node:crypto";

import type { WebFormField } from "./form-types";
import { normalizeFormFieldName } from "./form-matcher.ts";

export type FormValue = string | number | boolean;

export type FormValueValidation =
  | { valid: true; value: FormValue }
  | { valid: false; message: string };

function booleanValue(value: FormValue) {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== "string") return null;
  const normalized = normalizeFormFieldName(value);
  if (["true", "yes", "on", "checked"].includes(normalized)) return true;
  if (["false", "no", "off", "unchecked"].includes(normalized)) return false;
  return null;
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateLength(field: WebFormField, value: string): FormValueValidation {
  const { minLength, maxLength } = field.constraints ?? {};
  if (minLength !== undefined && value.length < minLength) {
    return { valid: false, message: `${field.name} must contain at least ${minLength} characters.` };
  }
  if (maxLength !== undefined && value.length > maxLength) {
    return { valid: false, message: `${field.name} must contain at most ${maxLength} characters.` };
  }
  return { valid: true, value };
}

export function validateFormValue(
  field: WebFormField,
  proposed: FormValue,
): FormValueValidation {
  if (field.disabled || field.readonly) {
    return { valid: false, message: `${field.name} is not editable.` };
  }
  if (["checkbox", "radio", "switch"].includes(field.fieldType)) {
    const parsed = booleanValue(proposed);
    return parsed === null
      ? { valid: false, message: `${field.name} requires a boolean-compatible value.` }
      : { valid: true, value: parsed };
  }
  if (field.fieldType === "number") {
    const parsed = typeof proposed === "number" ? proposed : Number(proposed);
    if (!Number.isFinite(parsed)) {
      return { valid: false, message: `${field.name} requires a number.` };
    }
    const { min, max } = field.constraints ?? {};
    if (min !== undefined && parsed < min) {
      return { valid: false, message: `${field.name} must be at least ${min}.` };
    }
    if (max !== undefined && parsed > max) {
      return { valid: false, message: `${field.name} must be at most ${max}.` };
    }
    return { valid: true, value: parsed };
  }
  if (typeof proposed !== "string") {
    return { valid: false, message: `${field.name} requires text.` };
  }
  const value = proposed.trim();
  if (field.fieldType === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return { valid: false, message: `${field.name} is not a valid basic email format.` };
  }
  if (field.fieldType === "date" && !validDate(value)) {
    return { valid: false, message: `${field.name} requires a valid YYYY-MM-DD date.` };
  }
  if (
    field.fieldType === "datetime" &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)
  ) {
    return { valid: false, message: `${field.name} requires a valid local date-time.` };
  }
  if (field.fieldType === "select") {
    const matches = (field.options ?? []).filter(
      (option) => normalizeFormFieldName(option) === normalizeFormFieldName(value),
    );
    if (matches.length !== 1) {
      return { valid: false, message: `${field.name} must match one discovered option.` };
    }
    return { valid: true, value: matches[0] };
  }
  return validateLength(field, value);
}

function syntheticText(field: WebFormField) {
  const base = field.fieldType === "textarea" ? "KINO Test Information" : "KINO Test";
  const { minLength = 0, maxLength = 160 } = field.constraints ?? {};
  if (maxLength < 4) return null;
  let value = base.slice(0, maxLength);
  while (value.length < minLength) value += " Test";
  return value.slice(0, maxLength);
}

export function generateSafeTestValue(field: WebFormField): FormValueValidation {
  let proposed: FormValue | null = null;
  switch (field.fieldType) {
    case "email":
      proposed = `kino-test-${randomBytes(4).toString("hex")}@example.com`;
      break;
    case "text":
    case "textarea":
      proposed = syntheticText(field);
      break;
    case "tel": {
      const { minLength = 8, maxLength = 16 } = field.constraints ?? {};
      const length = Math.min(Math.max(minLength, 8), maxLength);
      proposed = length >= 4 ? "0".repeat(length) : null;
      break;
    }
    case "number": {
      const { min = 0, max } = field.constraints ?? {};
      proposed = max !== undefined && min > max ? null : min;
      break;
    }
    case "date":
      proposed = "2099-01-01";
      break;
    case "datetime":
      proposed = "2099-01-01T12:00";
      break;
    case "checkbox":
    case "radio":
    case "switch":
      proposed = true;
      break;
    case "select":
      proposed = field.options?.find((option) => option.trim().length > 0) ?? null;
      break;
    case "unknown":
    case "password":
      proposed = null;
  }
  return proposed === null
    ? { valid: false, message: `Safe synthetic data cannot be generated for ${field.name}.` }
    : validateFormValue(field, proposed);
}
