import {
  cancelBrowserAction,
  closeBrowser,
  confirmBrowserAction,
  observeBrowser,
  openBrowserUrl,
  performBrowserAction,
} from "@/lib/kino/browser-worker/client";
import type { BrowserActionKind } from "@/lib/kino/browser-worker/types";

import { registerTool } from "./registry";

registerTool({
  name: "web_open_url",
  description:
    "Open any user-provided public HTTP(S) URL in KINO's isolated browser session and return a grounded semantic observation. No connected-site registration is required. Private/internal targets and unsafe redirects are blocked.",
  integration: "browser-worker",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "The exact public HTTP(S) URL supplied by the user." },
    },
    required: ["url"],
  },
  async execute(args, context) {
    if (typeof args.url !== "string" || !args.url.trim() || args.url.length > 2_048) {
      return { success: false, status: "INVALID_REQUEST", message: "A valid public HTTP(S) URL is required." };
    }
    return openBrowserUrl(context.conversationId, args.url.trim());
  },
});

registerTool({
  name: "web_observe",
  description:
    "Observe the current page using concise visible text and trusted semantic element IDs. Use after state changes or when the next step is unclear. Never invent elements not present in this result.",
  integration: "browser-worker",
  risk: "read",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    return observeBrowser(context.conversationId);
  },
});

registerTool({
  name: "web_action",
  description:
    "Perform one generic browser step using ONLY a semantic element ID from the latest trusted observation. Normal HTTP(S) links are READ_NAVIGATION and need no write confirmation. Downloads return DOWNLOAD_REQUIRES_HANDLING. Stale IDs return STALE_ELEMENT and must be replaced by a fresh observation. Supports click, ordinary-field fill, native select, check, uncheck, back, reload, and scroll. CSS/XPath selectors are never accepted. Write or critical clicks are prepared for confirmation instead of executed.",
  integration: "browser-worker",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["click", "fill", "select", "check", "uncheck", "back", "reload", "scroll"],
        description: "The permitted browser action.",
      },
      elementId: {
        type: "string",
        description: "A semantic ID such as e3 from the latest observation. Omit only for back, reload, or scroll.",
      },
      value: {
        type: "string",
        description: "An ordinary non-secret field value or native option. Never provide credentials, selectors, scripts, tokens, or payment data.",
      },
      direction: { type: "string", enum: ["up", "down"], description: "Scroll direction." },
    },
    required: ["action"],
  },
  async execute(args, context) {
    const allowed = new Set<BrowserActionKind>([
      "click", "fill", "select", "check", "uncheck", "back", "reload", "scroll",
    ]);
    if (typeof args.action !== "string" || !allowed.has(args.action as BrowserActionKind)) {
      return { success: false, status: "INVALID_REQUEST", message: "The browser action is not supported." };
    }
    if (args.elementId !== undefined && (typeof args.elementId !== "string" || !/^e\d+$/.test(args.elementId))) {
      return { success: false, status: "INVALID_REQUEST", message: "Only a semantic element ID from the latest observation is accepted." };
    }
    if (args.value !== undefined && !["string", "number", "boolean"].includes(typeof args.value)) {
      return { success: false, status: "INVALID_REQUEST", message: "The action value must be a simple scalar." };
    }
    if (typeof args.value === "string" && args.value.length > 4_096) {
      return { success: false, status: "INVALID_REQUEST", message: "The action value is too long." };
    }
    return performBrowserAction(context.conversationId, args.action as BrowserActionKind, {
      elementId: typeof args.elementId === "string" ? args.elementId : undefined,
      value: args.value as string | number | boolean | undefined,
      direction: args.direction === "up" ? "up" : args.direction === "down" ? "down" : undefined,
    });
  },
});

registerTool({
  name: "web_confirm_pending_action",
  description:
    "Execute the exact pending browser write only after the latest real user message explicitly confirms it. Critical actions require the exact strong phrase returned with the pending action. The worker revalidates the page and semantic element before activation and verifies the result.",
  integration: "browser-worker",
  risk: "write",
  executionPolicy: "server-confirmed",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    return confirmBrowserAction(context.conversationId, context.latestUserMessage);
  },
});

registerTool({
  name: "web_cancel_pending_action",
  description: "Cancel the exact pending browser write without changing the webpage.",
  integration: "browser-worker",
  risk: "read",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    return cancelBrowserAction(context.conversationId);
  },
});

registerTool({
  name: "web_close_session",
  description: "Close and discard the runtime-only browser session, authenticated cookies, and temporary site map.",
  integration: "browser-worker",
  risk: "read",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    return closeBrowser(context.conversationId);
  },
});
