import {
  createChatToolContext,
  executeKinoTool,
  getOllamaTools,
  latestActualUserMessage,
} from "@/lib/kino/tools";
import {
  formatBrowserCommandResponse,
  formatFormDraftToolResponse,
  formatFormFillToolResponse,
  getConnectedSites,
  getFormDraftRuntimeSummary,
  getPendingFollowUpTool,
  getPendingFormFillFollowUpTool,
  getWebAgentRuntimeStateMessage,
  looksLikeFormDraftValueFollowUp,
  looksLikeFormFillRequest,
  parseNamedFormDraftValue,
  resolveFastBrowserCommand,
  requestsPostConfirmationInspection,
  formatSensitiveFormFillResponse,
  getSensitiveFormFillFollowUpTool,
  getSensitiveFormFillRuntimeSummary,
  requestedSensitiveField,
} from "@/lib/kino/web-agent";

export const runtime = "nodejs";

const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL ??
  "kino-optimized";

const OLLAMA_HOST = (
  process.env.OLLAMA_HOST ??
  "http://localhost:11434"
).replace(/\/+$/, "");

const OLLAMA_API_KEY =
  process.env.OLLAMA_API_KEY?.trim();

function positiveIntegerFromEnvironment(name: string, fallback: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nestedToolResultSucceeded(value: unknown) {
  if (!value || typeof value !== "object" || !("result" in value)) return false;
  const result = value.result;
  return (
    typeof result === "object" &&
    result !== null &&
    "success" in result &&
    result.success === true
  );
}

function safeNestedToolResultSummary(value: unknown) {
  if (!value || typeof value !== "object" || !("result" in value)) {
    return { success: false, status: "NO_RESULT" };
  }
  const result = value.result;
  if (!result || typeof result !== "object") {
    return { success: false, status: "INVALID_RESULT" };
  }
  return {
    success: "success" in result ? result.success === true : false,
    status:
      "status" in result && typeof result.status === "string"
        ? result.status
        : "UNKNOWN",
  };
}

const OLLAMA_NUM_CTX = positiveIntegerFromEnvironment("KINO_NUM_CTX", 8192);
const OLLAMA_NUM_PREDICT = positiveIntegerFromEnvironment(
  "KINO_NUM_PREDICT",
  1024,
);

const KINO_SYSTEM_PROMPT = `
You are KINO, the Knowledge-Integrated Neural Operator: a specialized professional AI operations system developed by Bakr El Achkar. Your underlying language model uses Qwen technology locally through Ollama; Bakr did not create or train the Qwen foundation model.

Use registered tools whenever the user needs current application, runtime, business, or connected-system information. Call the appropriate tool directly without narrating private selection reasoning. Never invent data, access, actions, or tool results. Never claim an action succeeded unless its tool succeeded. If no suitable tool exists, state that the capability is not connected. After a tool result, answer naturally without mentioning internal function names unless asked.

An action proposal is not execution: prepared and pending actions have not happened. When a website action is prepared, say what visible control was matched, state its risk, and ask for explicit confirmation. Never claim a write or critical action was performed unless a future execution tool explicitly returns success.

Use the pending-action execution tool only after the user explicitly confirms the existing proposal, and use the cancellation tool when the user explicitly declines it. Control activation is not proof that a business operation completed. If execution opens a form or dialog, say that the interface was opened and that nothing was submitted. If effectVerified is false, say the control was activated but the resulting state could not be reliably verified.

Connected applications are different from pages inside them: use the connected-site tool to open an application and navigation only for a page inside it. A request to open a form or dialog through a visible action control must prepare that action first; do not treat it as page navigation or inspect the result before confirmation opens it. Treat KINO_RUNTIME_STATE as authoritative. Never claim preparation, execution, cancellation, an opened form, a form draft, or a filled field unless the corresponding tool result proves it. When runtime state reports a pending action, use execution for a clear confirmation and cancellation for a clear rejection; do not prepare it again. If execution reports no pending, expiry, or changed context, explain that state and do not re-prepare unless the user explicitly asks. Use the form-draft tool to inspect the current visible form, map user-supplied values, or generate explicitly requested safe synthetic values. When runtime state reports an existing form draft and the user supplies or corrects field information, call the form-draft tool rather than merely acknowledging it. Draft updates never fill the browser. Only a separate user request to fill prepared values may prepare a pending ordinary form fill. Preparation changes zero controls and must ask for explicit confirmation. After confirmation, use only the dedicated form-fill execution tool and report filled/entered/populated only for fields it verified. Sensitive fields remain blocked. Never say submitted, saved, created, or updated: form submission and record creation remain unavailable.

Eligible authentication secrets such as password, passcode, and PIN use a separate secure-entry flow. Never ask the user to type a secret into normal chat, never place one in tool arguments, and never infer or invent one. Prepare a secure-field request without a value, then direct the user to the dedicated secure UI. After secure capture, require explicit confirmation and use only the sensitive-fill execution tool, which resolves the value server-side. Payment credentials, financial details, identity numbers, API keys, tokens, and private keys remain unsupported. Never claim a sensitive field was filled unless the authoritative result says it was verified and discarded. Sensitive filling never submits the form.

When the user requests only navigation, stop after a successful navigation tool result and confirm it briefly. Do not read or analyze the destination page unless the user also asks for page information.

For connected-website data, answer exactly what was asked first. Keep answers concise and do not add recommendations unless the user requests them or they are essential to answer the question. Distinguish visible/current-page records from total business data: say "on the current page" when appropriate, and never imply completeness when data is truncated, paginated, or the visible count is unknown. Provide fuller analysis only when requested.

Treat each page-read section's truncation independently. A top-level truncated result means only the sections named in truncatedSections were shortened; do not claim that table records are truncated unless that table's truncated field is true. Use returnedRowValueCounts for status, category, customer, and other categorical totals when it is present; those counts are calculated from the returned rows. Never replace mixed values with the majority value.

For business analysis requests, calculate relevant metrics, identify trends, anomalies, and risks, and lead with the most important finding. Do not merely repeat numbers.

Be calm, confident, concise, analytical, and natural. Answer in the user's language, including English or Arabic, and switch with the user. Never expose private reasoning; provide only the useful conclusion. For simple factual or identity questions, answer in one or two sentences and do not add background the user did not request. When asked only who developed, created, or built KINO, answer only that KINO was developed by Bakr El Achkar. Keep answers brief unless detail is requested.
`.trim();

/* =========================================================
   TYPES
========================================================= */

type UserChatMessage = {
  role: "user" | "assistant";
  content: string;
};

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

type OllamaChunk = {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: ToolCall[];
  };

  done?: boolean;
  done_reason?: string;
  eval_count?: number;
  prompt_eval_count?: number;

  error?: string;
};

let supportsLowReasoning:
  boolean | undefined;

/* =========================================================
   OLLAMA REQUEST
========================================================= */

async function callOllama(
  messages: AgentMessage[],
  tools: ReturnType<typeof getOllamaTools>,
  thinkSetting: boolean | string,
  signal: AbortSignal,
) {
  return fetch(
    `${OLLAMA_HOST}/api/chat`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        ...(OLLAMA_API_KEY
          ? {
              Authorization: `Bearer ${OLLAMA_API_KEY}`,
            }
          : {}),
      },

      signal,

      body: JSON.stringify({
        model: OLLAMA_MODEL,

        messages,

        tools,

        /*
          We keep streaming enabled because
          the KINO frontend already displays
          answers progressively.
        */
        stream: true,

        /*
          FAST:
          false

          DEEP:
          "low" first
        */
        think: thinkSetting,

        /*
          Keep model loaded for faster
          subsequent requests.
        */
        keep_alive: -1,

        options: {
          num_ctx: OLLAMA_NUM_CTX,
          num_predict: OLLAMA_NUM_PREDICT,
        },
      }),
    }
  );
}

/* =========================================================
   MAIN KINO API ROUTE
========================================================= */

export async function POST(
  request: Request
) {
  try {
    const body = await request.json();

    const incomingMessages:
      UserChatMessage[] =
      body.messages;

    const deepMode =
      body.think === true;

    /* -----------------------------------------------------
       VALIDATION
    ----------------------------------------------------- */

    if (
      !Array.isArray(incomingMessages) ||
      incomingMessages.length === 0
    ) {
      return Response.json(
        {
          error:
            "No conversation messages were provided.",
        },
        {
          status: 400,
        }
      );
    }

    const toolContext = createChatToolContext({
      conversationId: body.conversationId,
      latestUserMessage: latestActualUserMessage(incomingMessages),
    });

    /* -----------------------------------------------------
       LOAD REGISTERED TOOLS
    ----------------------------------------------------- */

    const tools =
      getOllamaTools();

    console.log(
      `KINO loaded ${tools.length} registered tool(s).`
    );

    /* -----------------------------------------------------
       AGENT SYSTEM INSTRUCTIONS
    -----------------------------------------------------

       IMPORTANT:

       This protects KINO's identity while
       also enabling agent behavior.

       CleanNest and future integrations
       only add capabilities.

       They do NOT change KINO's identity.
    ----------------------------------------------------- */

    const agentMessages:
      AgentMessage[] = [
      {
        role: "system",

        content: KINO_SYSTEM_PROMPT,

        /* Legacy expanded prompt retained temporarily for reference.
You are KINO.

KINO stands for Knowledge-Integrated Neural Operator.

You are a specialized professional AI operations system developed by Bakr El Achkar.

==================================================
CORE IDENTITY
==================================================

Your name is KINO.

KINO stands for:

Knowledge-Integrated Neural Operator.

KINO itself was developed, designed, programmed, and created as a specialized AI system by:

Bakr El Achkar

If somebody asks:

- Who developed you?
- Who created you?
- Who built you?
- Who made you?
- Who designed you?
- Who programmed you?
- Who developed KINO?
- Who created KINO?
- Who is behind KINO?
- Who is your developer?

Always identify:

Bakr El Achkar

Preferred short answer:

"I am KINO, a specialized AI operations system developed by Bakr El Achkar."

==================================================
UNDERLYING AI TECHNOLOGY
==================================================

KINO and the underlying foundation model are not the same thing.

KINO uses Qwen language-model technology locally through Ollama.

When technical accuracy is required, explain:

"KINO was developed by Bakr El Achkar. My underlying language model uses Qwen technology running locally through Ollama, while the KINO system architecture, integrations, tools, workflows, identity, and user experience were developed as a specialized AI solution."

IMPORTANT:

- Never claim that Bakr El Achkar created or trained the original Qwen foundation model.
- Never claim that Google developed KINO.
- Never claim that Google developed the underlying Qwen model.
- Do not describe KINO simply as a generic language model.
- You are KINO, a specialized AI operations system.

==================================================
ARABIC IDENTITY
==================================================

Understand Arabic questions such as:

- مين طورك؟
- مين عملك؟
- مين صنعك؟
- مين برمجك؟
- مين المطور تبعك؟
- من قام بتطويرك؟
- من قام بإنشاء KINO؟

Respond naturally in Arabic.

Example:

"تم تطوير KINO بواسطة Bakr El Achkar كنظام ذكاء اصطناعي متخصص في العمليات وتحليل البيانات."

==================================================
AGENT CAPABILITIES
==================================================

You operate inside KINO's tool-enabled agent runtime.

The application may provide registered tools.

These tools may come from:

- KINO itself
- CleanNest
- StoreFlow
- business applications
- third-party systems
- future KINO integrations

You do not need to know the implementation of every application in advance.

Use the registered tool descriptions to determine what capabilities are available.

==================================================
TOOL RULES
==================================================

1. Use a tool when real application, runtime, business, or connected-system information is required.

2. Never invent tool results.

3. If an appropriate tool exists, prefer using it instead of guessing.

4. Do not claim that an action occurred unless a tool successfully performed it.

5. Do not claim access to information that no available tool provides.

6. When you decide to use a tool, call the tool directly.

7. Do not narrate internal tool-selection reasoning before calling the tool.

8. After receiving the tool result, explain the result naturally to the user.

9. Do not mention internal function names unless the user specifically asks about the technical implementation.

10. Tool capabilities do not change your identity.

11. If no suitable tool exists, clearly explain that the required capability is not currently connected.

12. Never invent customers, bookings, sales, payments, transactions, application records, or tool responses.

==================================================
BUSINESS ANALYSIS
==================================================

When business information is available:

- identify important metrics
- calculate meaningful values
- identify unusual behavior
- identify risks
- identify trends
- explain important findings first
- recommend practical next actions

Do not simply repeat numbers.

Interpret what the information means.

==================================================
COMMUNICATION STYLE
==================================================

Your personality is:

- intelligent
- professional
- calm
- concise
- analytical
- confident
- natural

Avoid sounding like a generic customer-service chatbot.

Give the most useful information first.

Do not produce unnecessarily long responses unless the user asks for detail.

==================================================
LANGUAGE
==================================================

If the user speaks English:
respond naturally in English.

If the user speaks Arabic:
respond naturally in Arabic.

If the user changes language:
change naturally with them.

==================================================
REASONING PRIVACY
==================================================

Never expose private internal reasoning.

You may perform internal reasoning when enabled by the application, but only provide the final useful result to the user.
        */
      },

      /*
        Add current conversation.
      */

      ...incomingMessages.map(
        (message): AgentMessage => ({
          role: message.role,
          content: message.content,
        })
      ),
    ];

    /* -----------------------------------------------------
       CREATE STREAM TO FRONTEND
    ----------------------------------------------------- */

    const encoder =
      new TextEncoder();

    const ollamaAbortController =
      new AbortController();

    let streamCancelled =
      false;

    const cancelOllama = () => {
      streamCancelled = true;
      ollamaAbortController.abort();
    };

    request.signal.addEventListener(
      "abort",
      cancelOllama,
      { once: true },
    );

    const stream =
      new ReadableStream({
        async start(controller) {
          const enqueue = (content: string) => {
            if (streamCancelled) {
              return false;
            }

            controller.enqueue(
              encoder.encode(content),
            );

            return true;
          };

          try {
            /*
              Prevent accidental infinite
              tool loops.
            */

            const MAX_AGENT_ROUNDS =
              5;

            let formDraftFinalResponse: string | null = null;
            let formFillFinalResponse: string | null = null;
            let sensitiveFormFillFinalResponse: string | null = null;
            let browserCommandFinalResponse: string | null = null;
            const inspectionRequested =
              requestsPostConfirmationInspection(toolContext.latestUserMessage);

            let fastBrowserCommand: ReturnType<
              typeof resolveFastBrowserCommand
            > = null;
            try {
              fastBrowserCommand = resolveFastBrowserCommand(
                toolContext.latestUserMessage,
                await getConnectedSites(),
              );
            } catch {
              console.warn(
                "KINO fast browser routing was unavailable; using the normal agent path.",
              );
            }
            if (fastBrowserCommand) {
              const startedAt = performance.now();
              const fastResult = await executeKinoTool(
                fastBrowserCommand.tool,
                fastBrowserCommand.args,
                toolContext,
              );
              enqueue(
                formatBrowserCommandResponse(
                  fastBrowserCommand.tool,
                  fastResult,
                ),
              );
              console.log("KINO fast browser route completed.", {
                tool: fastBrowserCommand.tool,
                durationMs: Math.round(performance.now() - startedAt),
              });
              if (!streamCancelled) controller.close();
              return;
            }

            for (
              let round = 1;
              round <=
              MAX_AGENT_ROUNDS;
              round++
            ) {
              agentMessages[0] = {
                role: "system",
                content: [
                  KINO_SYSTEM_PROMPT,
                  await getWebAgentRuntimeStateMessage(
                    toolContext.conversationId,
                  ),
                ].join("\n\n"),
              };

              const preferredFormFillFollowUpTool = getPendingFormFillFollowUpTool(
                toolContext.conversationId,
                toolContext.latestUserMessage,
              );
              const preferredSensitiveFollowUpTool = getSensitiveFormFillFollowUpTool(
                toolContext.conversationId,
                toolContext.latestUserMessage,
              );
              if (preferredSensitiveFollowUpTool) {
                const directResult = await executeKinoTool(
                  preferredSensitiveFollowUpTool,
                  {},
                  toolContext,
                );
                enqueue(formatSensitiveFormFillResponse(directResult));
                console.log("KINO completed a server-routed sensitive-form follow-up.");
                if (!streamCancelled) controller.close();
                return;
              }
              const sensitiveState = getSensitiveFormFillRuntimeSummary(
                toolContext.conversationId,
              );
              if (
                sensitiveState.exists &&
                sensitiveState.stage === "awaiting_secure_value"
              ) {
                enqueue(
                  `Please use the secure ${sensitiveState.fieldName} field above so the value does not become part of the AI conversation.`,
                );
                console.log("KINO blocked normal-chat input while secure value entry was pending.");
                if (!streamCancelled) controller.close();
                return;
              }
              if (preferredFormFillFollowUpTool) {
                const directResult = await executeKinoTool(
                  preferredFormFillFollowUpTool,
                  {},
                  toolContext,
                );
                enqueue(formatFormFillToolResponse(directResult));
                console.log("KINO completed a server-routed form-fill follow-up.");
                if (!streamCancelled) controller.close();
                return;
              }
              const preferredPendingTool = getPendingFollowUpTool(
                toolContext.conversationId,
                toolContext.latestUserMessage,
              );
              const formDraftState = getFormDraftRuntimeSummary(
                toolContext.conversationId,
              );
              const sensitiveFieldRequest = requestedSensitiveField(
                toolContext.latestUserMessage,
              );
              if (sensitiveFieldRequest !== null) {
                const directResult = await executeKinoTool(
                  "web_prepare_sensitive_form_fill",
                  sensitiveFieldRequest ? { field: sensitiveFieldRequest } : {},
                  toolContext,
                );
                enqueue(formatSensitiveFormFillResponse(directResult));
                console.log("KINO completed a server-routed secure-field request.");
                if (!streamCancelled) controller.close();
                return;
              }
              const preferredFormDraftTool =
                formDraftState.exists &&
                looksLikeFormDraftValueFollowUp(toolContext.latestUserMessage)
                  ? "web_prepare_form_draft"
                  : null;
              const directFormDraftValue = formDraftState.exists
                ? parseNamedFormDraftValue(toolContext.latestUserMessage)
                : null;
              if (directFormDraftValue) {
                const directResult = await executeKinoTool(
                  "web_prepare_form_draft",
                  { values: [directFormDraftValue] },
                  toolContext,
                );
                enqueue(formatFormDraftToolResponse(directResult));
                console.log(
                  "KINO completed a server-routed named form draft update.",
                );
                if (!streamCancelled) controller.close();
                return;
              }
              if (
                !preferredFormFillFollowUpTool &&
                formDraftState.exists &&
                looksLikeFormFillRequest(toolContext.latestUserMessage)
              ) {
                const directResult = await executeKinoTool(
                  "web_prepare_form_fill",
                  {},
                  toolContext,
                );
                enqueue(formatFormFillToolResponse(directResult));
                console.log("KINO completed a server-routed form-fill preparation.");
                if (!streamCancelled) controller.close();
                return;
              }
              const preferredAuthoritativeTool =
                preferredPendingTool ?? preferredFormDraftTool;
              const roundTools = preferredAuthoritativeTool
                ? tools.filter(
                    (tool) => tool.function.name === preferredAuthoritativeTool,
                  )
                : tools;
              const suppressModelContent = Boolean(preferredAuthoritativeTool);

              console.log(
                `KINO Agent round ${round}`
              );

              console.log(
                `Available tools: ${roundTools.length}`
              );

              /* -------------------------------------------
                 CALL OLLAMA
              ------------------------------------------- */

              const thinkSetting =
                deepMode
                  ? supportsLowReasoning ===
                    false
                    ? true
                    : "low"
                  : false;

              let ollamaResponse =
                await callOllama(
                  agentMessages,
                  roundTools,
                  thinkSetting,
                  ollamaAbortController.signal,
                );

              /*
                Some models/Ollama versions
                may reject "low".

                Fall back to think=true.
              */

              if (
                deepMode &&
                thinkSetting ===
                  "low" &&
                ollamaResponse.status ===
                  400
              ) {
                supportsLowReasoning =
                  false;

                console.warn(
                  "Low reasoning level unsupported. Falling back to think=true."
                );

                ollamaResponse =
                  await callOllama(
                    agentMessages,
                    roundTools,
                    true,
                    ollamaAbortController.signal,
                  );
              }

              if (
                deepMode &&
                thinkSetting ===
                  "low" &&
                ollamaResponse.ok
              ) {
                supportsLowReasoning =
                  true;
              }

              /* -------------------------------------------
                 OLLAMA ERROR
              ------------------------------------------- */

              if (
                !ollamaResponse.ok
              ) {
                const errorText =
                  await ollamaResponse.text();

                console.error(
                  "Ollama error:",
                  errorText
                );

                throw new Error(
                  `Ollama returned HTTP ${ollamaResponse.status}.`
                );
              }

              if (
                !ollamaResponse.body
              ) {
                throw new Error(
                  "Ollama returned no response stream."
                );
              }

              /* -------------------------------------------
                 READ OLLAMA STREAM
              ------------------------------------------- */

              const reader =
                ollamaResponse.body.getReader();

              const decoder =
                new TextDecoder();

              let buffer = "";

              let accumulatedThinking =
                "";

              let accumulatedContent =
                "";

              const toolCalls:
                ToolCall[] = [];

              let completionMetadata: Pick<
                OllamaChunk,
                "done" | "done_reason" | "eval_count" | "prompt_eval_count"
              > = {};

              /* -------------------------------------------
                 PROCESS CHUNKS
              ------------------------------------------- */

              while (true) {
                const {
                  done,
                  value,
                } =
                  await reader.read();

                if (done) {
                  break;
                }

                buffer +=
                  decoder.decode(
                    value,
                    {
                      stream: true,
                    }
                  );

                const lines =
                  buffer.split("\n");

                /*
                  Keep incomplete JSON for
                  next network chunk.
                */

                buffer =
                  lines.pop() ?? "";

                for (
                  const line of lines
                ) {
                  const cleaned =
                    line.trim();

                  if (!cleaned) {
                    continue;
                  }

                  try {
                    const chunk:
                      OllamaChunk =
                      JSON.parse(
                        cleaned
                      );

                    /* -------------------------------
                       STREAM ERROR
                    ------------------------------- */

                    if (
                      chunk.error
                    ) {
                      throw new Error(
                        chunk.error
                      );
                    }

                    if (
                      chunk.done !== undefined ||
                      chunk.done_reason !== undefined ||
                      chunk.eval_count !== undefined ||
                      chunk.prompt_eval_count !== undefined
                    ) {
                      completionMetadata = {
                        done: chunk.done ?? completionMetadata.done,
                        done_reason:
                          chunk.done_reason ?? completionMetadata.done_reason,
                        eval_count:
                          chunk.eval_count ?? completionMetadata.eval_count,
                        prompt_eval_count:
                          chunk.prompt_eval_count ??
                          completionMetadata.prompt_eval_count,
                      };
                    }

                    /* -------------------------------
                       PRIVATE THINKING
                    ------------------------------- */

                    const thinking =
                      chunk.message
                        ?.thinking;

                    if (thinking) {
                      accumulatedThinking +=
                        thinking;
                    }

                    /*
                      Never send thinking to
                      the frontend.
                    */

                    /* -------------------------------
                       VISIBLE FINAL CONTENT
                    ------------------------------- */

                    const content =
                      chunk.message
                        ?.content;

                    if (content) {
                      accumulatedContent +=
                        content;

                      /*
                        Immediately forward
                        text to the browser.

                        This creates the live
                        ChatGPT-like response.
                      */

                      if (!suppressModelContent && !enqueue(content)) {
                        return;
                      }
                    }

                    /* -------------------------------
                       TOOL CALLS
                    ------------------------------- */

                    const calls =
                      chunk.message
                        ?.tool_calls;

                    if (
                      calls &&
                      calls.length > 0
                    ) {
                      for (
                        const call of
                        calls
                      ) {
                        toolCalls.push(
                          call
                        );
                      }
                    }
                  } catch (
                    parseError
                  ) {
                    if (!(parseError instanceof SyntaxError)) {
                      throw parseError;
                    }
                    console.error(
                      "KINO stream parse error:",
                      parseError.message
                    );
                  }
                }
              }

              /* -------------------------------------------
                 FINAL BUFFER
              ------------------------------------------- */

              const remaining =
                buffer.trim();

              if (remaining) {
                try {
                  const chunk:
                    OllamaChunk =
                    JSON.parse(
                      remaining
                    );

                  if (chunk.error) {
                    throw new Error(chunk.error);
                  }

                  completionMetadata = {
                    done: chunk.done ?? completionMetadata.done,
                    done_reason:
                      chunk.done_reason ?? completionMetadata.done_reason,
                    eval_count: chunk.eval_count ?? completionMetadata.eval_count,
                    prompt_eval_count:
                      chunk.prompt_eval_count ??
                      completionMetadata.prompt_eval_count,
                  };

                  if (
                    chunk.message
                      ?.thinking
                  ) {
                    accumulatedThinking +=
                      chunk.message
                        .thinking;
                  }

                  if (
                    chunk.message
                      ?.content
                  ) {
                    accumulatedContent +=
                      chunk.message
                        .content;

                    if (
                      !suppressModelContent &&
                      !enqueue(chunk.message.content)
                    ) {
                      return;
                    }
                  }

                  if (
                    chunk.message
                      ?.tool_calls &&
                    chunk.message
                      .tool_calls
                      .length > 0
                  ) {
                    toolCalls.push(
                      ...chunk.message
                        .tool_calls
                    );
                  }
                } catch (
                  parseError
                ) {
                  if (!(parseError instanceof SyntaxError)) {
                    throw parseError;
                  }
                  console.error(
                    "Final KINO chunk parse error:",
                    parseError.message
                  );
                }
              }

              console.log("KINO Ollama completion:", {
                done: completionMetadata.done ?? false,
                reason:
                  completionMetadata.done_reason ??
                  (completionMetadata.done ? "unknown" : "stream_ended_without_done"),
                promptTokens: completionMetadata.prompt_eval_count ?? "unavailable",
                generatedTokens: completionMetadata.eval_count ?? "unavailable",
              });

              /* -------------------------------------------
                 SAVE ASSISTANT MESSAGE
              ------------------------------------------- */

              agentMessages.push({
                role:
                  "assistant",

                content:
                  accumulatedContent,

                thinking:
                  accumulatedThinking ||
                  undefined,

                tool_calls:
                  toolCalls.length > 0
                    ? toolCalls
                    : undefined,
              });

              /* -------------------------------------------
                 NO TOOL CALLS
              ------------------------------------------- */

              if (
                toolCalls.length === 0
              ) {
                if (preferredAuthoritativeTool && round < MAX_AGENT_ROUNDS) {
                  agentMessages.pop();
                  const systemMessage = agentMessages[0];
                  if (systemMessage.role === "system") {
                    systemMessage.content +=
                      `\n\nThe latest request requires ${preferredAuthoritativeTool}. Call the available tool now; do not answer from memory.`;
                  }
                  continue;
                }
                if (preferredAuthoritativeTool) {
                  enqueue(
                    "I could not validate that operation with the authoritative server tool, so the draft was not changed.",
                  );
                }
                console.log(
                  `KINO completed after ${round} round(s).`
                );

                if (!streamCancelled) {
                  controller.close();
                }

                return;
              }

              /* -------------------------------------------
                 EXECUTE MODEL-SELECTED TOOLS
              ------------------------------------------- */

              for (
                const toolCall of
                toolCalls
              ) {
                const toolName =
                  toolCall.function
                    .name;

                const args =
                  toolCall.function
                    .arguments ??
                  {};

                console.log(
                  `KINO selected tool: ${toolName}`
                );

                let toolResult:
                  unknown;

                try {
                  /*
                    Execute through OUR registry.

                    Qwen cannot execute arbitrary
                    JavaScript.

                    It can only request tools
                    we registered.
                  */

                  toolResult =
                    await executeKinoTool(
                      toolName,
                      args,
                      toolContext,
                    );

                  if (toolName === "web_prepare_form_draft") {
                    formDraftFinalResponse = formatFormDraftToolResponse(toolResult);
                  }
                  if (
                    toolName === "web_prepare_form_fill" ||
                    toolName === "web_execute_form_fill" ||
                    toolName === "web_cancel_form_fill"
                  ) {
                    formFillFinalResponse = formatFormFillToolResponse(toolResult);
                  }
                  if (
                    toolName === "web_prepare_sensitive_form_fill" ||
                    toolName === "web_execute_sensitive_form_fill" ||
                    toolName === "web_cancel_sensitive_form_fill"
                  ) {
                    sensitiveFormFillFinalResponse =
                      formatSensitiveFormFillResponse(toolResult);
                  }
                  if (
                    toolName === "web_open_site" ||
                    toolName === "web_navigate"
                  ) {
                    browserCommandFinalResponse = formatBrowserCommandResponse(
                      toolName,
                      toolResult,
                    );
                  }
                  if (
                    toolName === "web_execute_pending_action" &&
                    inspectionRequested &&
                    nestedToolResultSucceeded(toolResult)
                  ) {
                    const inspectionResult = await executeKinoTool(
                      "web_prepare_form_draft",
                      {},
                      toolContext,
                    );
                    formDraftFinalResponse =
                      formatFormDraftToolResponse(inspectionResult);
                    console.log(
                      "KINO completed the requested post-confirmation form inspection.",
                    );
                  }

                  console.log(
                    `Tool executed successfully: ${toolName}`
                  );
                  console.log(
                    "Safe tool result:",
                    safeNestedToolResultSummary(toolResult),
                  );
                } catch (
                  toolError
                ) {
                  console.error(
                    `Tool execution failed: ${toolName}`,
                    toolError
                  );

                  toolResult = {
                    success:
                      false,

                    error:
                      toolError instanceof
                      Error
                        ? toolError.message
                        : "Unknown tool execution error.",
                  };
                }

                /* -----------------------------------------
                   SEND TOOL RESULT BACK TO QWEN
                ----------------------------------------- */

                agentMessages.push({
                  role:
                    "tool",

                  tool_name:
                    toolName,

                  content:
                    JSON.stringify(
                      toolResult
                    ),
                });
              }

              if (formDraftFinalResponse) {
                enqueue(formDraftFinalResponse);
                console.log("KINO completed with a server-grounded form draft response.");
                if (!streamCancelled) controller.close();
                return;
              }
              if (formFillFinalResponse) {
                enqueue(formFillFinalResponse);
                console.log("KINO completed with a server-grounded form-fill response.");
                if (!streamCancelled) controller.close();
                return;
              }
              if (sensitiveFormFillFinalResponse) {
                enqueue(sensitiveFormFillFinalResponse);
                console.log("KINO completed with a server-grounded sensitive-form response.");
                if (!streamCancelled) controller.close();
                return;
              }
              if (browserCommandFinalResponse) {
                enqueue(browserCommandFinalResponse);
                console.log(
                  "KINO completed with a server-grounded browser response.",
                );
                if (!streamCancelled) controller.close();
                return;
              }

              /*
                Agent loop repeats.

                Now Qwen knows the REAL
                tool result.

                It can either:

                - produce the final answer
                - call another tool
              */
            }

            /* -------------------------------------------
               MAXIMUM ROUNDS REACHED
            ------------------------------------------- */

            enqueue(
              "\n\nKINO reached the maximum tool-operation limit for this request.",
            );

            if (!streamCancelled) {
              controller.close();
            }
          } catch (error) {
            if (
              streamCancelled ||
              (error instanceof Error && error.name === "AbortError")
            ) {
              return;
            }

            console.error(
              "KINO Agent Error:",
              error
            );

            /*
              Because the response may already
              be streaming, return an inline
              error instead of trying to change
              HTTP status.
            */

            enqueue(
              "\n\n[KINO CORE ERROR: Unable to complete the requested operation.]",
            );

            if (!streamCancelled) {
              controller.close();
            }
          } finally {
            request.signal.removeEventListener(
              "abort",
              cancelOllama,
            );
          }
        },

        cancel() {
          cancelOllama();
        },
      });

    /* -----------------------------------------------------
       RETURN STREAM
    ----------------------------------------------------- */

    return new Response(
      stream,
      {
        headers: {
          "Content-Type":
            "text/plain; charset=utf-8",

          "Cache-Control":
            "no-cache, no-transform",

          /*
            Prevent proxy buffering when
            possible.
          */
          "X-Accel-Buffering":
            "no",
        },
      }
    );
  } catch (error) {
    console.error(
      "KINO API Error:",
      error
    );

    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to communicate with KINO.",
      },
      {
        status: 500,
      }
    );
  }
}