import {
  createChatToolContext,
  executeKinoTool,
  getOllamaTools,
} from "@/lib/kino/tools";
import { browserRuntimeStateMessage } from "@/lib/kino/browser-worker/routing";

export const runtime = "nodejs";

const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL ??
  "kino-optimized";

type ToolCall = {
  type?: "function";

  function: {
    index?: number;
    name: string;
    arguments: Record<string, unknown>;
  };
};

type AgentMessage =
  | {
      role: "system";
      content: string;
    }
  | {
      role: "user";
      content: string;
    }
  | {
      role: "assistant";
      content?: string;
      thinking?: string;
      tool_calls?: ToolCall[];
    }
  | {
      role: "tool";
      tool_name: string;
      content: string;
    };

type OllamaResponse = {
  message?: {
    role?: "assistant";
    content?: string;
    thinking?: string;
    tool_calls?: ToolCall[];
  };

  done?: boolean;
  done_reason?: string;
};

function safeToolArgumentsForDiagnostics(
  toolName: string,
  args: Record<string, unknown>,
) {
  if (toolName !== "web_prepare_form_draft") return args;
  return {
    siteProvided: typeof args.site === "string",
    valueCount: Array.isArray(args.values) ? args.values.length : 0,
    generateTestData: args.generateTestData === true,
  };
}

export async function POST(
  request: Request
) {
  try {
    const body =
      await request.json();

    const prompt =
      typeof body.prompt === "string"
        ? body.prompt.trim()
        : "";

    if (!prompt) {
      return Response.json(
        {
          error:
            "A prompt is required.",
        },
        {
          status: 400,
        }
      );
    }

    const toolContext = createChatToolContext({
      conversationId: body.conversationId,
      latestUserMessage: prompt,
    });

    /*
      =========================================
      1. LOAD ALL REGISTERED KINO TOOLS
      =========================================
    */

    const tools =
      getOllamaTools();

    console.log(
      `KINO Agent received ${tools.length} available tool(s).`
    );

    /*
      =========================================
      2. START AGENT CONVERSATION
      =========================================
    */

    const messages: AgentMessage[] = [
      {
        role: "system",
        content: browserRuntimeStateMessage(),
      },
      {
        role: "user",
        content: prompt,
      },
    ];

    /*
      Keep this so our test response can
      prove exactly what KINO decided to use.
    */

    const executedTools: Array<{
      name: string;
      arguments: Record<
        string,
        unknown
      >;
      result: unknown;
    }> = [];

    /*
      =========================================
      3. AGENT LOOP
      =========================================

      KINO can:

      User
       ↓
      tool
       ↓
      result
       ↓
      another tool
       ↓
      result
       ↓
      final answer

      Maximum 5 rounds prevents an accidental
      infinite tool loop.
    */

    const MAX_AGENT_ROUNDS = 5;

    for (
      let round = 1;
      round <= MAX_AGENT_ROUNDS;
      round++
    ) {
      messages[0] = {
        role: "system",
        content: browserRuntimeStateMessage(),
      };

      console.log(
        `KINO Agent round ${round}`
      );

      /*
        Ask Qwen what to do.

        IMPORTANT:

        We give it the tool definitions.

        We DO NOT manually inspect the prompt
        for words like "status".

        Qwen decides whether a tool is needed.
      */

      const ollamaResponse =
        await fetch(
          "http://localhost:11434/api/chat",
          {
            method: "POST",

            headers: {
              "Content-Type":
                "application/json",
            },

            body: JSON.stringify({
              model: OLLAMA_MODEL,

              messages,

              tools,

              /*
                Keep this first agent test FAST.

                We don't need deep reasoning
                just to choose one simple tool.
              */
              think: false,

              /*
                Non-streaming is intentional
                ONLY for this isolated test.

                Once agent logic works,
                we'll reconnect streaming.
              */
              stream: false,

              keep_alive: -1,
            }),
          }
        );

      if (!ollamaResponse.ok) {
        const errorText =
          await ollamaResponse.text();

        console.error(
          "Ollama agent error:",
          errorText
        );

        return Response.json(
          {
            error:
              "Ollama rejected the KINO agent request.",

            details:
              errorText,
          },
          {
            status:
              ollamaResponse.status,
          }
        );
      }

      const data: OllamaResponse =
        await ollamaResponse.json();

      const assistantMessage =
        data.message;

      if (!assistantMessage) {
        throw new Error(
          "Ollama returned no assistant message."
        );
      }

      /*
        Store EXACTLY what the model decided.

        This is important because Ollama needs
        the assistant tool-call message in the
        conversation before the tool result.
      */

      const toolCalls =
        assistantMessage.tool_calls ??
        [];

      messages.push({
        role: "assistant",

        content:
          assistantMessage.content ??
          "",

        thinking:
          assistantMessage.thinking,

        tool_calls:
          toolCalls,
      });

      /*
        =========================================
        4. NO TOOL CALL?
        =========================================

        Then the model believes it can answer
        directly.

        Agent loop is finished.
      */

      if (
        toolCalls.length === 0
      ) {
        return Response.json({
          success: true,

          agent:
            "KINO",

          rounds:
            round,

          toolsAvailable:
            tools.length,

          toolsUsed:
            executedTools,

          finalAnswer:
            assistantMessage.content ??
            "",
        });
      }

      /*
        =========================================
        5. EXECUTE MODEL-SELECTED TOOLS
        =========================================
      */

      for (
        const call of toolCalls
      ) {
        const toolName =
          call.function.name;

        const args =
          call.function.arguments ??
          {};

        console.log(
          `KINO selected tool: ${toolName}`
        );

        const safeArguments = safeToolArgumentsForDiagnostics(toolName, args);

        console.log("Safe arguments:", safeArguments);

        /*
          This goes through OUR registry.

          The model cannot execute arbitrary
          JavaScript itself.

          It can only request registered tools.
        */

        const toolResult =
          await executeKinoTool(
            toolName,
            args,
            toolContext,
          );

        console.log(
          `Tool ${toolName} executed successfully.`
        );

        executedTools.push({
          name:
            toolName,

          arguments:
            safeArguments,

          result:
            toolResult,
        });

        /*
          =======================================
          6. SEND TOOL RESULT BACK TO QWEN
          =======================================

          This is what allows KINO to understand
          the REAL result of the operation.
        */

        messages.push({
          role: "tool",

          tool_name:
            toolName,

          content:
            JSON.stringify(
              toolResult
            ),
        });
      }

      /*
        Loop repeats.

        Qwen now sees:

        User request
        +
        its tool call
        +
        actual tool result

        and can produce the final response.
      */
    }

    return Response.json(
      {
        error:
          "KINO reached the maximum number of agent rounds.",

        toolsUsed:
          executedTools,
      },
      {
        status: 500,
      }
    );
  } catch (error) {
    console.error(
      "KINO Agent Test Error:",
      error
    );

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unknown KINO agent error.",
      },
      {
        status: 500,
      }
    );
  }
}
