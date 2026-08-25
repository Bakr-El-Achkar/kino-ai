import type { Locator } from "playwright";

import { normalizeFormFieldName } from "./form-matcher.ts";
import type {
  FormFillFieldIdentity,
  FormDraftFieldValue,
  SupportedFormFillFieldType,
  WebFormField,
} from "./form-types";
import type { LiveWebFormField } from "./form-discovery.ts";

const SUPPORTED_TYPES = new Set<SupportedFormFillFieldType>([
  "text",
  "email",
  "tel",
  "number",
  "date",
  "datetime",
  "textarea",
  "select",
  "checkbox",
]);

export function supportedFormFillField(field: WebFormField) {
  if (!SUPPORTED_TYPES.has(field.fieldType as SupportedFormFillFieldType)) return false;
  if (
    field.fieldType === "select" &&
    (!field.options?.length || (field.controlKind !== undefined && field.controlKind !== "select"))
  ) return false;
  if (
    field.fieldType === "checkbox" &&
    field.controlKind !== undefined &&
    field.controlKind !== "input"
  ) return false;
  if (
    ["text", "email", "tel", "number", "date", "datetime", "textarea"].includes(field.fieldType) &&
    field.controlKind === "aria"
  ) return false;
  return true;
}

export function rediscoverFormFillField(
  identity: FormFillFieldIdentity,
  fields: LiveWebFormField[],
) {
  const matches = fields.filter(
    ({ field }) =>
      normalizeFormFieldName(field.name) === normalizeFormFieldName(identity.name) &&
      field.role === identity.role &&
      field.fieldType === identity.fieldType,
  );
  if (matches.length === 0) return { status: "FIELD_NOT_AVAILABLE" } as const;
  if (matches.length > 1) return { status: "FIELD_AMBIGUOUS" } as const;
  if (matches[0].field.id !== identity.draftFieldId) {
    return { status: "FIELD_NOT_AVAILABLE" } as const;
  }
  return { status: "MATCHED", live: matches[0] } as const;
}

async function verifyText(locator: Locator, expected: string | number) {
  if ((await locator.getAttribute("contenteditable")) === "true") {
    return (await locator.textContent()) === String(expected);
  }
  const actual = await locator.inputValue();
  return typeof expected === "number" ? Number(actual) === expected : actual === expected;
}

async function verifySelect(locator: Locator, expected: string) {
  const selected = locator.locator("option:checked");
  return (await selected.count()) === 1 &&
    normalizeFormFieldName((await selected.textContent()) ?? "") ===
      normalizeFormFieldName(expected);
}

export async function fillAndVerifyOrdinaryField({
  locator,
  field,
  draftValue,
}: {
  locator: Locator;
  field: WebFormField;
  draftValue: FormDraftFieldValue;
}) {
  const value = draftValue.value;
  switch (field.fieldType) {
    case "text":
    case "email":
    case "tel":
    case "number":
    case "date":
    case "datetime":
    case "textarea":
      if (typeof value === "boolean") return false;
      await locator.fill(String(value), { timeout: 15_000 });
      return verifyText(locator, value);
    case "select":
      if (typeof value !== "string") return false;
      await locator.selectOption({ label: value }, { timeout: 15_000 });
      return verifySelect(locator, value);
    case "checkbox":
      if (typeof value !== "boolean") return false;
      if (value) await locator.check({ timeout: 15_000 });
      else await locator.uncheck({ timeout: 15_000 });
      return (await locator.isChecked()) === value;
    default:
      return false;
  }
}

export type ValidatedFormFillItem = {
  identity: FormFillFieldIdentity;
  value: FormDraftFieldValue;
  live: LiveWebFormField;
};

export async function executeValidatedFormFillPlan(
  items: ValidatedFormFillItem[],
  hooks: {
    filled?: (item: ValidatedFormFillItem) => void;
    verified?: (item: ValidatedFormFillItem) => void;
    failed?: (item: ValidatedFormFillItem) => void;
  } = {},
) {
  const completed: ValidatedFormFillItem[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    let mutationAttempted = false;
    try {
      if (
        !(await item.live.locator.isVisible()) ||
        !(await item.live.locator.isEnabled()) ||
        item.live.field.readonly
      ) {
        throw new Error("Field stopped being safely editable.");
      }
      mutationAttempted = true;
      const verified = await fillAndVerifyOrdinaryField({
        locator: item.live.locator,
        field: item.live.field,
        draftValue: item.value,
      });
      hooks.filled?.(item);
      if (!verified) throw new Error("Field verification failed.");
      completed.push(item);
      hooks.verified?.(item);
    } catch {
      hooks.failed?.(item);
      return {
        status: "partial" as const,
        completed,
        failed: item,
        notAttempted: items.slice(index + 1),
        browserMutationPossible: mutationAttempted,
      };
    }
  }
  return { status: "completed" as const, completed };
}
