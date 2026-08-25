import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright";

import { safeUrlForLog } from "./page-safety";
import type {
  WebFormDescriptor,
  WebFormField,
  WebFormFieldConstraints,
  WebFormFieldType,
  WebFormSubmitControl,
} from "./form-types";

const MAX_CONTROLS = 100;
const MAX_OPTIONS = 100;
const CONTROL_SELECTOR = [
  "input:not([type='hidden'])",
  "textarea",
  "select",
  "[contenteditable='true']",
  "[role='textbox']",
  "[role='searchbox']",
  "[role='combobox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
].join(", ");

type FormScope = {
  locator: Locator;
  kind: WebFormDescriptor["scope"];
  name?: string;
  controlCount: number;
};

export type LiveWebFormField = {
  field: WebFormField;
  locator: Locator;
};

export type LiveWebForm = {
  descriptor: WebFormDescriptor;
  fields: LiveWebFormField[];
};

function compact(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}

async function accessibleName(locator: Locator, allowOwnText = false) {
  const label = await locator.evaluate((element, mayReadOwnText) => {
    const control = element as HTMLInputElement;
    const labels = "labels" in control && control.labels
      ? Array.from(control.labels).map((item) => item.textContent ?? "").join(" ")
      : "";
    const labelledBy = element.getAttribute("aria-labelledby")
      ?.split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
    const directName = (
      labels ||
      labelledBy ||
      element.getAttribute("aria-label") ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      (mayReadOwnText ? element.textContent : "") ||
      ""
    );
    if (directName.trim()) return directName;

    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth += 1) {
      if (ancestor.tagName.toLowerCase() === "form") break;
      const nearbyLabels = Array.from(ancestor.querySelectorAll("label"));
      const nearbyControls = ancestor.querySelectorAll(
        "input:not([type='hidden']), textarea, select, [contenteditable='true'], [role='textbox'], [role='searchbox'], [role='combobox'], [role='checkbox'], [role='radio'], [role='switch']",
      );
      if (nearbyLabels.length === 1 && nearbyControls.length === 1) {
        return nearbyLabels[0].textContent ?? "";
      }
      ancestor = ancestor.parentElement;
    }

    const semanticName = element.getAttribute("name") ?? "";
    return /^[a-z][a-z0-9_.-]{0,80}$/i.test(semanticName)
      ? semanticName.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_.-]+/g, " ")
      : "";
  }, allowOwnText);
  return compact(label);
}

async function scopeName(locator: Locator) {
  const semanticName = await accessibleName(locator);
  if (semanticName) return semanticName;
  const heading = locator.getByRole("heading").first();
  try {
    return (await heading.isVisible()) ? compact(await heading.innerText()) : undefined;
  } catch {
    return undefined;
  }
}

async function visibleControlCount(locator: Locator) {
  const controls = locator.locator(CONTROL_SELECTOR);
  const count = Math.min(await controls.count(), MAX_CONTROLS);
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    try {
      if (await controls.nth(index).isVisible()) visible += 1;
    } catch {
      // Ignore controls that detach during client rendering.
    }
  }
  return visible;
}

async function visibleCandidates(locator: Locator, kind: FormScope["kind"]) {
  const results: FormScope[] = [];
  const count = Math.min(await locator.count(), 20);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      const controlCount = await visibleControlCount(candidate);
      if (!(await candidate.isVisible()) || controlCount === 0) {
        continue;
      }
      results.push({
        locator: candidate,
        kind,
        name: await scopeName(candidate),
        controlCount,
      });
    } catch {
      // Ignore containers that detach while discovering the active form.
    }
  }
  return results;
}

function uniqueLargest(candidates: FormScope[]) {
  const ranked = [...candidates].sort(
    (left, right) => right.controlCount - left.controlCount,
  );
  return ranked.length > 0 &&
    (ranked.length === 1 || ranked[0].controlCount > ranked[1].controlCount)
    ? ranked[0]
    : null;
}

async function activeScope(candidates: FormScope[]) {
  const active: FormScope[] = [];
  for (const candidate of candidates) {
    if (
      await candidate.locator.evaluate((element) =>
        element.contains(document.activeElement),
      )
    ) {
      active.push(candidate);
    }
  }
  return active.length === 1 ? active[0] : null;
}

async function chooseFormScope(page: Page): Promise<FormScope | null> {
  const dialogs = await visibleCandidates(page.getByRole("dialog"), "dialog");
  if (dialogs.length === 1) return dialogs[0];
  if (dialogs.length > 1) {
    const modalDialogs: FormScope[] = [];
    for (const dialog of dialogs) {
      if ((await dialog.locator.getAttribute("aria-modal")) === "true") {
        modalDialogs.push(dialog);
      }
    }
    if (modalDialogs.length === 1) return modalDialogs[0];
    return (await activeScope(dialogs)) ?? uniqueLargest(dialogs);
  }

  const forms = await visibleCandidates(page.locator("form"), "form");
  if (forms.length === 1) return forms[0];
  if (forms.length > 1) {
    const active = await activeScope(forms);
    if (active) return active;
    const named = forms.filter((form) => Boolean(form.name));
    if (named.length === 1) return named[0];
    return uniqueLargest(forms);
  }

  const groups = await visibleCandidates(
    page.locator("[role='group'], section").filter({
      has: page.getByRole("heading"),
    }),
    "group",
  );
  const substantial = groups.filter((group) => group.controlCount >= 2);
  return substantial.length === 1
    ? substantial[0]
    : (await activeScope(substantial)) ?? uniqueLargest(substantial);
}

function fieldType(inputType: string | null, tagName: string, role: string | null) {
  if (role === "switch") return "switch" as const;
  if (role === "checkbox") return "checkbox" as const;
  if (role === "radio") return "radio" as const;
  if (role === "combobox" || tagName === "select") return "select" as const;
  if (tagName === "textarea") return "textarea" as const;
  const normalized = (inputType ?? "text").toLowerCase();
  const supported: Record<string, WebFormFieldType> = {
    text: "text",
    password: "password",
    email: "email",
    tel: "tel",
    number: "number",
    date: "date",
    "datetime-local": "datetime",
    checkbox: "checkbox",
    radio: "radio",
  };
  return supported[normalized] ?? "unknown";
}

function roleFor(type: WebFormFieldType, explicitRole: string | null) {
  if (explicitRole) return explicitRole;
  if (["text", "email", "password", "tel", "number", "date", "datetime", "textarea"].includes(type)) {
    return "textbox";
  }
  if (type === "select") return "combobox";
  return type;
}

function safeNumber(value: string | null) {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function constraintsFor(locator: Locator): Promise<WebFormFieldConstraints | undefined> {
  const [minLength, maxLength, min, max, step] = await Promise.all([
    locator.getAttribute("minlength"),
    locator.getAttribute("maxlength"),
    locator.getAttribute("min"),
    locator.getAttribute("max"),
    locator.getAttribute("step"),
  ]);
  const constraints = {
    minLength: safeNumber(minLength),
    maxLength: safeNumber(maxLength),
    min: safeNumber(min),
    max: safeNumber(max),
    step: safeNumber(step),
  };
  return Object.values(constraints).some((value) => value !== undefined)
    ? constraints
    : undefined;
}

async function optionsFor(locator: Locator, type: WebFormFieldType) {
  if (type !== "select") return undefined;
  const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
  if (tagName !== "select") return undefined;
  const options = (await locator.locator("option").allTextContents())
    .map(compact)
    .filter(Boolean)
    .slice(0, MAX_OPTIONS);
  return options.length > 0 && new Set(options).size === options.length
    ? options
    : undefined;
}

async function discoverFields(scope: FormScope, pageUrl: string) {
  const controls = scope.locator.locator(CONTROL_SELECTOR);
  const count = Math.min(await controls.count(), MAX_CONTROLS);
  const fields: LiveWebFormField[] = [];
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    try {
      if (!(await control.isVisible())) continue;
      const [name, tagName, inputType, explicitRole, required, ariaRequired, readonly, ariaReadonly] =
        await Promise.all([
          accessibleName(control),
          control.evaluate((element) => element.tagName.toLowerCase()),
          control.getAttribute("type"),
          control.getAttribute("role"),
          control.getAttribute("required"),
          control.getAttribute("aria-required"),
          control.getAttribute("readonly"),
          control.getAttribute("aria-readonly"),
        ]);
      if (!name) continue;
      const type = fieldType(inputType, tagName, explicitRole);
      const controlKind: NonNullable<WebFormField["controlKind"]> =
        tagName === "input" || tagName === "textarea" || tagName === "select"
          ? tagName
          : (await control.getAttribute("contenteditable")) === "true"
            ? "contenteditable"
            : "aria";
      const id = createHash("sha256")
        .update([pageUrl, scope.kind, scope.name ?? "", index, roleFor(type, explicitRole), name, type].join("|"))
        .digest("hex")
        .slice(0, 24);
      const field: WebFormField = {
        id,
        role: roleFor(type, explicitRole),
        name,
        fieldType: type,
        controlKind,
        required: required !== null || ariaRequired === "true",
        disabled: await control.isDisabled(),
        readonly: readonly !== null || ariaReadonly === "true",
        options: await optionsFor(control, type),
        constraints: await constraintsFor(control),
      };
      fields.push({ field, locator: control });
    } catch {
      // Ignore controls that detach while the form is being inspected.
    }
  }
  return fields;
}

async function discoverSubmitControls(scope: FormScope) {
  const buttons = scope.locator.getByRole("button");
  const count = Math.min(await buttons.count(), 30);
  const controls: WebFormSubmitControl[] = [];
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    try {
      if (!(await button.isVisible())) continue;
      const isSubmit = await button.evaluate((element) => {
        if (element instanceof HTMLButtonElement) {
          return element.type === "submit" && Boolean(element.form);
        }
        if (element instanceof HTMLInputElement) {
          return element.type === "submit" && Boolean(element.form);
        }
        return false;
      });
      if (!isSubmit) continue;
      const name = await accessibleName(button, true);
      if (name) controls.push({ role: "button", name, risk: "write" });
    } catch {
      // Ignore buttons that detach during discovery.
    }
  }
  return controls;
}

export async function discoverCurrentWebForm(
  page: Page,
  siteId: string,
): Promise<WebFormDescriptor | null> {
  return (await discoverLiveWebForm(page, siteId))?.descriptor ?? null;
}

export async function discoverLiveWebForm(
  page: Page,
  siteId: string,
): Promise<LiveWebForm | null> {
  const scope = await chooseFormScope(page);
  if (!scope) return null;
  const pageUrl = safeUrlForLog(page.url());
  const liveFields = await discoverFields(scope, pageUrl);
  if (liveFields.length === 0) return null;
  const fields = liveFields.map(({ field }) => field);
  const submitControls = await discoverSubmitControls(scope);
  const structuralIdentity = {
    pageUrl,
    scope: scope.kind,
    formName: scope.name,
    fields: fields.map(({ role, name, fieldType, controlKind, required }) => ({
      role,
      name,
      fieldType,
      controlKind,
      required,
    })),
    submitControls,
  };
  const descriptor: WebFormDescriptor = {
    siteId,
    pageUrl,
    title: compact(await page.title()),
    formName: scope.name,
    scope: scope.kind,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(structuralIdentity))
      .digest("hex")
      .slice(0, 24),
    fields,
    submitControls,
  };
  return { descriptor, fields: liveFields };
}
