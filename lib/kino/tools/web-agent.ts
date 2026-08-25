import {
  cancelPendingConnectedAction,
  cancelConnectedFormFill,
  executeConnectedFormFill,
  executePendingConnectedAction,
  navigateConnectedSite,
  openConnectedSite,
  prepareConnectedFormDraft,
  prepareConnectedFormFill,
  prepareConnectedAction,
  readConnectedPage,
  cancelSensitiveFormFill,
  executeSensitiveFormFill,
  prepareSensitiveFormFill,
} from "@/lib/kino/web-agent";

import { registerTool } from "./registry";

registerTool({
  name: "web_prepare_form_draft",

  description:
    "Inspect the single active visible form and prepare or update a reviewable server-side draft from semantic field/value pairs. When runtime state reports an existing form draft, use this for follow-up messages that provide or correct field information; do not merely acknowledge them. Use with no values to list the current form fields. It may generate clearly synthetic test data when explicitly requested. It never reads existing values, fills controls, clicks, or submits.",

  integration: "web-agent",

  risk: "read",

  parameters: {
    type: "object",
    properties: {
      site: {
        type: "string",
        description:
          "Optional connected website identifier or name. Omit when only one website is connected.",
      },
      values: {
        type: "array",
        description:
          "Optional user-supplied semantic field/value pairs. Field names must be natural concepts, never selectors or DOM identifiers.",
        items: {
          type: "object",
          description: "One user-provided form value.",
          properties: {
            field: {
              type: "string",
              description: "Natural semantic field concept, such as the label the user named.",
            },
            value: {
              type: "string",
              description: "The user-provided value. Numbers and booleans are also accepted by the server.",
            },
          },
          required: ["field", "value"],
        },
      },
      generateTestData: {
        type: "boolean",
        description:
          "True only when the user explicitly requests clearly synthetic test values for remaining supported required fields.",
      },
    },
  },

  async execute(args, context) {
    const site = args.site;
    const rawValues = args.values ?? [];
    const generateTestData = args.generateTestData ?? false;
    if (site !== undefined && typeof site !== "string") {
      return {
        success: false,
        status: "INVALID_ARGUMENTS",
        message: "The connected website must be identified by name or id.",
      };
    }
    if (!Array.isArray(rawValues) || rawValues.length > 30) {
      return {
        success: false,
        status: "INVALID_ARGUMENTS",
        message: "Form values must be a list of at most 30 semantic field/value pairs.",
      };
    }
    const values = [];
    for (const rawValue of rawValues) {
      if (!rawValue || typeof rawValue !== "object" || Array.isArray(rawValue)) {
        return {
          success: false,
          status: "INVALID_ARGUMENTS",
          message: "Each form value requires a semantic field and scalar value.",
        };
      }
      const item = rawValue as Record<string, unknown>;
      if (
        typeof item.field !== "string" ||
        !item.field.trim() ||
        item.field.length > 120 ||
        !["string", "number", "boolean"].includes(typeof item.value) ||
        (typeof item.value === "string" && item.value.length > 1_000)
      ) {
        return {
          success: false,
          status: "INVALID_ARGUMENTS",
          message:
            "Each form value requires a concise semantic field and a string, number, or boolean value.",
        };
      }
      values.push({
        field: item.field.trim(),
        value: item.value as string | number | boolean,
      });
    }
    if (typeof generateTestData !== "boolean") {
      return {
        success: false,
        status: "INVALID_ARGUMENTS",
        message: "generateTestData must be a boolean.",
      };
    }
    return prepareConnectedFormDraft({
      conversationId: context.conversationId,
      siteId: site,
      values,
      generateTestData,
    });
  },
});

registerTool({
  name: "web_prepare_form_fill",
  description:
    "Prepare a server-side plan to fill the current authoritative form draft into the current visible form. Use only after the user separately asks to fill prepared values. It revalidates the draft, form fingerprint, and semantic fields, excludes sensitive and unsupported fields, creates a pending write operation, and makes zero browser changes. Never provide selectors, URLs, or values as arguments.",
  integration: "web-agent",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      site: {
        type: "string",
        description: "Optional connected website identifier or name. Omit when only one website is connected.",
      },
    },
  },
  async execute(args, context) {
    const site = args.site;
    if (site !== undefined && typeof site !== "string") {
      return { success: false, status: "INVALID_ARGUMENTS", message: "The connected website must be identified by name or id." };
    }
    return prepareConnectedFormFill({ conversationId: context.conversationId, siteId: site });
  },
});

registerTool({
  name: "web_execute_form_fill",
  description:
    "Execute ONLY an existing server-side pending form-fill plan after the latest real user message explicitly confirms it. The server reloads the referenced draft, revalidates the live form and every semantic field before mutation, fills supported ordinary fields, verifies each result, and never touches sensitive or submit controls.",
  integration: "web-agent",
  risk: "write",
  executionPolicy: "server-confirmed",
  parameters: {
    type: "object",
    properties: {
      site: {
        type: "string",
        description: "Optional connected website identifier or name. Omit to execute the uniquely pending scoped fill.",
      },
    },
  },
  async execute(args, context) {
    const site = args.site;
    if (site !== undefined && typeof site !== "string") {
      return { success: false, status: "INVALID_ARGUMENTS", message: "The connected website must be identified by name or id." };
    }
    return executeConnectedFormFill({ siteId: site, context });
  },
});

registerTool({
  name: "web_cancel_form_fill",
  description:
    "Cancel ONLY an existing pending form-fill operation when the latest real user message explicitly declines it. It makes zero browser changes.",
  integration: "web-agent",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      site: {
        type: "string",
        description: "Optional connected website identifier or name. Omit to cancel the uniquely pending scoped fill.",
      },
    },
  },
  async execute(args, context) {
    const site = args.site;
    if (site !== undefined && typeof site !== "string") {
      return { success: false, status: "INVALID_ARGUMENTS", message: "The connected website must be identified by name or id." };
    }
    return cancelConnectedFormFill({ siteId: site, context });
  },
});

registerTool({
  name: "web_prepare_sensitive_form_fill",
  description:
    "Prepare a secure-entry request for exactly one eligible sensitive authentication field on the current live form. Use for password, passcode, or PIN filling requests. It accepts only a natural semantic field name, never the value. It rejects payment, financial, identity, API-key, token, and other unsupported sensitive categories and makes zero browser changes.",
  integration: "web-agent",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      site: {
        type: "string",
        description: "Optional connected website identifier or name.",
      },
      field: {
        type: "string",
        description: "Optional natural semantic field name. Omit when exactly one eligible sensitive authentication field remains.",
      },
    },
  },
  async execute(args, context) {
    const site = args.site;
    const field = args.field;
    if (site !== undefined && typeof site !== "string") {
      return { success: false, status: "INVALID_ARGUMENTS", message: "The connected website must be identified by name or id." };
    }
    if (field !== undefined && (typeof field !== "string" || !field.trim() || field.length > 120)) {
      return { success: false, status: "INVALID_ARGUMENTS", message: "The sensitive field must be a concise natural semantic name." };
    }
    return prepareSensitiveFormFill({
      conversationId: context.conversationId,
      siteId: site,
      requestedField: typeof field === "string" ? field.trim() : undefined,
    });
  },
});

registerTool({
  name: "web_execute_sensitive_form_fill",
  description:
    "Execute ONLY the current server-staged sensitive authentication-field fill after explicit real-user confirmation. It accepts no secret argument, revalidates the page, form, eligibility, and exact semantic field, fills that one field, verifies it internally, discards the staged secret, and never submits.",
  integration: "web-agent",
  risk: "write",
  executionPolicy: "server-confirmed",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    return executeSensitiveFormFill({ context });
  },
});

registerTool({
  name: "web_cancel_sensitive_form_fill",
  description:
    "Cancel the active secure sensitive-field request after an explicit user cancellation. It immediately discards any staged sensitive value and makes zero browser changes.",
  integration: "web-agent",
  risk: "read",
  parameters: { type: "object", properties: {} },
  async execute(_args, context) {
    return cancelSensitiveFormFill({ context });
  },
});

registerTool({
  name: "web_open_site",
  description:
    "Open or reuse an authenticated connected application itself. Use this for requests like 'open CleanNest' or 'open my connected website'. Do not use it for pages or sections inside the application; use web_navigate for those.",
  integration: "web-agent",
  risk: "read",
  parameters: {
    type: "object",
    properties: {
      site: {
        type: "string",
        description:
          "Optional connected application identifier or name. Omit for the only connected website.",
      },
    },
  },
  async execute(args) {
    const site = args.site;
    if (site !== undefined && typeof site !== "string") {
      return {
        success: false,
        status: "INVALID_ARGUMENTS",
        message: "The connected application must be identified by name or id.",
      };
    }
    return openConnectedSite(site);
  },
});

registerTool({
  name: "web_navigate",

  description:
    "Navigate to a visible page or section inside the current connected application. Natural wrappers like 'open the customers section' are normalized server-side. Do not use this to activate a button/action or open a form/dialog; prepare that visible action with web_prepare_action.",

  integration: "web-agent",

  risk: "read",

  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        description:
          "Semantic destination requested by the user, such as a visible page or section name in the connected website.",
      },
      site: {
        type: "string",
        description:
          "Optional connected website identifier or name. Omit when only one website is connected.",
      },
    },
    required: ["target"],
  },

  async execute(args) {
    const target = args.target;
    const site = args.site;

    if (typeof target !== "string") {
      return {
        success: false,
        code: "INVALID_ARGUMENTS",
        message: "The web navigation tool requires a semantic target string.",
      };
    }
    if (site !== undefined && typeof site !== "string") {
      return {
        success: false,
        code: "INVALID_ARGUMENTS",
        message: "The connected website must be identified by a name or id.",
      };
    }

    return navigateConnectedSite({ siteId: site, target });
  },
});

registerTool({
  name: "web_prepare_action",

  description:
    "Prepare a NEW potentially mutating action from a visible control on the current page. Use this when the user asks to activate a button or open a form/dialog through a visible action, even if they also ask to inspect the resulting interface. It creates pending confirmation but executes nothing. Do not use it for confirmation follow-ups when server runtime state already reports a pending action.",

  integration: "web-agent",

  risk: "read",

  parameters: {
    type: "object",
    properties: {
      intent: {
        type: "string",
        description:
          "The user's concise natural-language action request, without selectors, URLs, code, or confirmation state.",
      },
      site: {
        type: "string",
        description:
          "Optional connected website identifier or name. Omit when only one website is connected.",
      },
    },
    required: ["intent"],
  },

  async execute(args, context) {
    const intent = args.intent;
    const site = args.site;

    if (typeof intent !== "string") {
      return {
        success: false,
        status: "INVALID_ARGUMENTS",
        message: "The action-preparation tool requires an intent string.",
      };
    }
    if (site !== undefined && typeof site !== "string") {
      return {
        success: false,
        status: "INVALID_ARGUMENTS",
        message: "The connected website must be identified by a name or id.",
      };
    }

    return prepareConnectedAction({
      conversationId: context.conversationId,
      siteId: site,
      intent,
    });
  },
});

registerTool({
  name: "web_execute_pending_action",

  description:
    "Execute ONLY an EXISTING pending website action after the latest real user message explicitly confirms it. Prefer this for confirmation follow-ups when server runtime state reports a pending action. It activates only the prepared control once and never fills or submits forms.",

  integration: "web-agent",

  risk: "write",

  executionPolicy: "server-confirmed",

  parameters: {
    type: "object",
    properties: {
      site: {
        type: "string",
        description:
          "Optional connected website identifier or name. Omit when only one website is connected.",
      },
    },
  },

  async execute(args, context) {
    const site = args.site;
    if (site !== undefined && typeof site !== "string") {
      return {
        success: false,
        status: "INVALID_ARGUMENTS",
        message: "The connected website must be identified by a name or id.",
      };
    }
    return executePendingConnectedAction({ siteId: site, context });
  },
});

registerTool({
  name: "web_cancel_pending_action",

  description:
    "Cancel ONLY an EXISTING pending website action when the latest real user message explicitly declines it. Prefer this for negative follow-ups when server runtime state reports a pending action. No browser control is activated.",

  integration: "web-agent",

  risk: "read",

  parameters: {
    type: "object",
    properties: {
      site: {
        type: "string",
        description:
          "Optional connected website identifier or name. Omit when only one website is connected.",
      },
    },
  },

  async execute(args, context) {
    const site = args.site;
    if (site !== undefined && typeof site !== "string") {
      return {
        success: false,
        status: "INVALID_ARGUMENTS",
        message: "The connected website must be identified by a name or id.",
      };
    }
    return cancelPendingConnectedAction({ siteId: site, context });
  },
});

registerTool({
  name: "web_read_page",

  description:
    "Read and understand the CURRENT page already open in a connected authenticated website. Use this when the user asks what is visible, requests counts, statuses, records, summaries, or analysis from the current webpage. It does not navigate, click controls, submit forms, or perform write actions.",

  integration: "web-agent",

  risk: "read",

  parameters: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description:
          "Optional concise description of the information the user wants extracted or understood from the current page.",
      },
      site: {
        type: "string",
        description:
          "Optional connected website identifier or name. Omit when only one website is connected.",
      },
    },
  },

  async execute(args) {
    const focus = args.focus;
    const site = args.site;

    if (focus !== undefined && typeof focus !== "string") {
      return {
        success: false,
        code: "INVALID_ARGUMENTS",
        message: "The page-reading focus must be a string when provided.",
      };
    }
    if (site !== undefined && typeof site !== "string") {
      return {
        success: false,
        code: "INVALID_ARGUMENTS",
        message: "The connected website must be identified by a name or id.",
      };
    }

    return readConnectedPage({ siteId: site, focus });
  },
});
