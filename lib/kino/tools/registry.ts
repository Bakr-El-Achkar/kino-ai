import {
  KinoTool,
  KinoToolContext,
  OllamaToolDefinition,
} from "./types";
import { createManualToolContext } from "./execution-context";

/*
  =========================================
  KINO TOOL REGISTRY
  =========================================

  This Map contains every capability that
  connected applications provide to KINO.

    KINO itself does NOT need website-specific
    knowledge to use a generic capability.
*/

const tools = new Map<
  string,
  KinoTool
>();

export function registerTool(
  tool: KinoTool
) {
  /*
    Next.js can re-evaluate a tool module during development while keeping
    this registry module alive. Refresh the definition by name so a hot
    reload does not take every tool-backed route offline.
  */
  if (tools.has(tool.name)) {
    tools.set(
      tool.name,
      tool
    );

    return;
  }

  tools.set(
    tool.name,
    tool
  );
}

/*
  Returns all registered KINO tools.
*/

export function getRegisteredTools() {
  return Array.from(
    tools.values()
  );
}

/*
  Returns only the information Ollama
  needs to understand the available tools.

  Notice that execute() is NOT sent
  to the model.
*/

export function getOllamaTools():
  OllamaToolDefinition[] {
  return getRegisteredTools().map(
    (tool) => ({
      type: "function",

      function: {
        name: tool.name,

        description:
          tool.description,

        parameters:
          tool.parameters,
      },
    })
  );
}

/*
  Safely execute a tool selected by KINO.
*/

export async function executeKinoTool(
  toolName: string,
  args: Record<string, unknown>,
  context: KinoToolContext = createManualToolContext(),
) {
  const tool =
    tools.get(toolName);

  if (!tool) {
    throw new Error(
      `Unknown KINO tool: ${toolName}`
    );
  }

  /*
    IMPORTANT:

    For now we automatically allow READ
    tools only.

    WRITE and CRITICAL tools will later
    require confirmation.
  */

  if (tool.risk !== "read" && tool.executionPolicy !== "server-confirmed") {
    throw new Error(
      `Tool "${toolName}" requires user confirmation.`
    );
  }

  if (
    tool.risk !== "read" &&
    (context.source !== "chat" || !context.latestUserMessage)
  ) {
    throw new Error(
      `Tool "${toolName}" requires server-verified chat confirmation context.`
    );
  }

  const result =
    await tool.execute(
      args,
      context
    );

  return {
    success: true,

    tool: tool.name,

    integration:
      tool.integration,

    risk: tool.risk,

    result,
  };
}
