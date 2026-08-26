import type { Locator, Page } from "playwright";

import type { BrowserObservation, SemanticElement, SemanticElementRole } from "../lib/kino/browser-worker/types.ts";

export type RegisteredElement = {
  locator: Locator;
  semantic: SemanticElement;
  pageUrl: string;
  tagName: string;
  buttonType?: string;
};

export type ElementRegistry = Map<string, RegisteredElement>;

const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input:not([type=hidden])", "textarea", "select",
  "[role=button]", "[role=link]", "[role=tab]", "[role=checkbox]",
  "[role=radio]", "[role=switch]", "[contenteditable=true]",
].join(",");

function safePageUrl(value: string) {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.href;
}

function safeHref(value: string | null, pageUrl: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value, pageUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function inferredRole(tag: string, explicitRole: string, inputType: string): SemanticElementRole {
  if (["button", "link", "tab", "checkbox", "radio", "switch"].includes(explicitRole)) {
    return explicitRole as SemanticElementRole;
  }
  if (tag === "a") return "link";
  if (tag === "button" || ["button", "submit", "reset"].includes(inputType)) return "button";
  if (tag === "select") return "combobox";
  if (inputType === "checkbox") return "checkbox";
  if (inputType === "radio") return "radio";
  if (inputType === "search") return "searchbox";
  return "textbox";
}

type ElementMetadata = {
  tagName: string;
  role: string;
  inputType: string;
  label: string;
  text: string;
  placeholder: string;
  title: string;
  disabled: boolean;
  checked?: boolean;
  selectedOption?: string;
  options?: string[];
  href: string | null;
  buttonType?: string;
};

async function metadata(locator: Locator): Promise<ElementMetadata> {
  return locator.evaluate((node) => {
    const element = node as HTMLElement;
    const input = element as HTMLInputElement;
    const select = element as HTMLSelectElement;
    const labels = "labels" in input && input.labels ? Array.from(input.labels) : [];
    return {
      tagName: element.tagName.toLowerCase(),
      role: element.getAttribute("role")?.toLowerCase() ?? "",
      inputType: input.type?.toLowerCase() ?? "",
      label: element.getAttribute("aria-label")?.trim() || labels.map((label) => label.innerText.trim()).filter(Boolean).join(" "),
      text: (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 300),
      placeholder: element.getAttribute("placeholder")?.trim() ?? "",
      title: element.getAttribute("title")?.trim() ?? "",
      disabled: Boolean(input.disabled || element.getAttribute("aria-disabled") === "true"),
      checked: typeof input.checked === "boolean" ? input.checked : undefined,
      selectedOption: select.tagName === "SELECT" ? select.selectedOptions[0]?.textContent?.trim() : undefined,
      options: select.tagName === "SELECT" ? Array.from(select.options).map((option) => option.textContent?.trim() || "").filter(Boolean).slice(0, 100) : undefined,
      href: element.getAttribute("href"),
      buttonType: element.tagName === "BUTTON" ? (element as HTMLButtonElement).type : undefined,
    };
  });
}

function challengeStatus(text: string, hasPassword: boolean) {
  if (/\b(?:captcha|recaptcha|hcaptcha|verify you are human|human verification)\b/i.test(text)) return "CAPTCHA_REQUIRED" as const;
  if (/\b(?:two[- ]factor|multi[- ]factor|verification code|one[- ]time (?:code|password)|authenticator|security key|webauthn)\b/i.test(text)) return "MFA_REQUIRED" as const;
  return hasPassword ? "AUTH_REQUIRED" as const : "OBSERVED" as const;
}

export async function observePage(page: Page, registry: ElementRegistry): Promise<BrowserObservation> {
  registry.clear();
  await page.locator("body").waitFor({ state: "visible", timeout: 10_000 });
  const pageUrl = page.url();
  const candidates = page.locator(INTERACTIVE_SELECTOR);
  const elements: SemanticElement[] = [];
  const count = Math.min(await candidates.count(), 160);
  for (let index = 0; index < count && elements.length < 80; index += 1) {
    const locator = candidates.nth(index);
    if (!(await locator.isVisible().catch(() => false))) continue;
    const data = await metadata(locator).catch(() => null);
    if (!data) continue;
    const role = inferredRole(data.tagName, data.role, data.inputType);
    const name = (data.label || data.text || data.placeholder || data.title || role).slice(0, 200);
    const id = `e${elements.length + 1}`;
    const semantic: SemanticElement = {
      id,
      role,
      name,
      label: data.label || undefined,
      text: data.text || undefined,
      placeholder: data.placeholder || undefined,
      inputType: data.inputType || undefined,
      checked: ["checkbox", "radio", "switch"].includes(role) ? data.checked : undefined,
      disabled: data.disabled,
      selectedOption: data.selectedOption || undefined,
      options: data.options?.length ? data.options : undefined,
      href: role === "link" ? safeHref(data.href, pageUrl) : undefined,
    };
    elements.push(semantic);
    registry.set(id, { locator, semantic, pageUrl, tagName: data.tagName, buttonType: data.buttonType });
  }

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const visibleText = Array.from(new Set(bodyText.split(/\r?\n/).map((line) => line.trim().replace(/\s+/g, " ")).filter(Boolean)))
    .slice(0, 30)
    .map((line) => line.replace(/\bpassword\s*[:=]\s*\S+/gi, "Password: [REDACTED]").slice(0, 300));
  const password = elements.find((element) => element.inputType === "password");
  const username = elements.find((element) => ["email", "text"].includes(element.inputType ?? "") && /(?:email|user|login)/i.test(element.name));
  const status = challengeStatus(bodyText, Boolean(password));
  return {
    status,
    url: safePageUrl(pageUrl),
    title: (await page.title()).slice(0, 300),
    visibleText,
    elements,
    truncated: (await candidates.count()) > count || visibleText.length >= 30,
    authentication: status === "AUTH_REQUIRED" ? {
      usernameField: Boolean(username),
      passwordField: true,
      usernameLabel: username?.name,
      passwordLabel: password?.name,
    } : undefined,
    learnedNavigation: Array.from(new Set(elements.filter((element) => element.role === "link" || element.role === "tab").map((element) => element.name))).slice(0, 40),
  };
}
