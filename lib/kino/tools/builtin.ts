import {
  registerTool,
} from "./registry";

/*
  =========================================
  BUILT-IN KINO TOOL
  =========================================

  This isn't related to CleanNest.

  Its purpose is to prove that KINO's
  generic Tool Registry works before
  adding application connectors.
*/

registerTool({
  name:
    "kino_get_runtime_status",

  description:
    "Get the current status and server time of the local KINO runtime. Use this when information about the currently running KINO system is required.",

  integration:
    "kino",

  risk:
    "read",

  parameters: {
    type: "object",

    properties: {},
  },

  async execute(
    _args,
    context
  ) {
    return {
      system:
        "KINO",

      status:
        "online",

      environment:
        "local",

      serverTime:
        context.requestedAt.toISOString(),

      neuralEngine:
        "Ollama",

      model:
        "kino",

      toolSystem:
        "online",
    };
  },
});