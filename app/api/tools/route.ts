import {
  executeKinoTool,
  getRegisteredTools,
} from "@/lib/kino/tools";

export const runtime =
  "nodejs";

/*
  =========================================
  GET /api/tools
  =========================================

  Shows tools currently registered
  inside KINO.

  Development/testing endpoint.
*/

export async function GET() {
  const tools =
    getRegisteredTools();

  return Response.json({
    system:
      "KINO Tool Registry",

    status:
      "online",

    toolCount:
      tools.length,

    tools:
      tools.map(
        (tool) => ({
          name:
            tool.name,

          description:
            tool.description,

          integration:
            tool.integration,

          risk:
            tool.risk,

          parameters:
            tool.parameters,
        })
      ),
  });
}

/*
  =========================================
  POST /api/tools
  =========================================

  Manually executes a registered tool.

  This lets us verify that tools work
  BEFORE connecting the AI agent.
*/

export async function POST(
  request: Request
) {
  try {
    const body =
      await request.json();

    const toolName =
      body.tool;

    const args =
      body.args ?? {};

    if (
      typeof toolName !==
      "string"
    ) {
      return Response.json(
        {
          error:
            "A tool name is required.",
        },
        {
          status: 400,
        }
      );
    }

    const result =
      await executeKinoTool(
        toolName,
        args
      );

    return Response.json(
      result
    );
  } catch (error) {
    console.error(
      "KINO tool error:",
      error
    );

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown tool error.",
      },
      {
        status: 500,
      }
    );
  }
}