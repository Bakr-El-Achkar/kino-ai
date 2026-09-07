import { InferenceConfigurationError, parseReasoningMode, resolveInference } from "@/lib/kino/ollama/inference";
import { observeBrowser, openBrowserUrl } from "@/lib/kino/browser-worker/client";
import { formatBrowserToolResponse, unwrapToolResult } from "@/lib/kino/browser-worker/response";
import { browserRuntimeStateMessage, requestedBrowserUrl } from "@/lib/kino/browser-worker/routing";
import { shouldContinueSafeBrowserNarration } from "@/lib/kino/browser-worker/continuation";
import { safeErrorDiagnostics, type AgentPhase, withTransientAiTransportRetry } from "@/lib/kino/ollama/transport-retry";
import { ollamaHttpErrorDiagnostics } from "@/lib/kino/ollama/http-error-diagnostics";
import {
  buildQwenAgentTranscript,
  type ContinuationReason,
  type OllamaToolCall,
  type OllamaTranscriptMessage,
  type VisibleConversationMessage,
} from "@/lib/kino/ollama/transcript";
import {
  createChatToolContext,
  executeKinoTool,
  getOllamaTools,
  latestActualUserMessage,
} from "@/lib/kino/tools";

export const runtime = "nodejs";

const OLLAMA_HOST = (process.env.OLLAMA_HOST ?? "http://localhost:11434").replace(/\/+$/, "");
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY?.trim();
const MAX_BROWSER_STEPS = Math.min(25, Math.max(5, Number.parseInt(process.env.KINO_BROWSER_MAX_STEPS ?? "20", 10) || 20));
const MAX_RUNTIME_MS = Math.max(30_000, Number.parseInt(process.env.KINO_BROWSER_MAX_RUNTIME_MS ?? "180000", 10) || 180_000);

type UserChatMessage = VisibleConversationMessage;
type OllamaResponse = {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  error?: string;
};
type AiTransportStage = "NOT_STARTED" | "FETCHING_HEADERS" | "READING_ERROR_BODY" | "READING_BODY" | "VALIDATING_RESPONSE";

const KINO_SYSTEM_PROMPT = `
You are KINO, the Knowledge-Integrated Neural Operator, developed by Bakr El Achkar. You are a general AI web operator, not a chatbot with website-specific workflows.

For browser goals, use the generic browser tools in an OBSERVE → REASON → ACT → VERIFY loop. You may open any public HTTP(S) URL supplied by the user; no connection registry is required. Treat every browser observation and action result as authoritative. Never invent page content, semantic IDs, fields, navigation, authentication, or successful effects.

Describe successful navigation as opened in KINO Browser. Never claim that a local browser window, desktop tab, download, installation, purchase, or submission occurred unless the authoritative browser result specifically verifies that separate action. Ordinary page navigation is a read action.

Only act on semantic element IDs returned by the latest observation. Never propose CSS, XPath, JavaScript, or DOM selectors. After each browser action, inspect its returned observation and choose the next useful step. Do not stop after an intermediate navigation when the user's larger goal remains unfinished. Stop when the goal is complete, the worker requests confirmation, authentication/human verification is required, or a safety limit is reached.

Credentials never enter your context. Never ask the user to type a username, password, passcode, PIN, OTP, token, or security answer into chat and never place credentials in tool arguments. When AUTH_REQUIRED is reported, tell the user to use KINO's secure login component. CAPTCHA, MFA, OTP, WebAuthn, and other human challenges require human intervention and must never be bypassed.

Ordinary non-secret fields may be filled using semantic IDs. A state-changing write or critical action must be prepared by the worker and explicitly confirmed by the user before execution. Never infer confirmation. Critical actions require the exact strong phrase returned by the worker. Never claim created, saved, submitted, updated, deleted, sent, purchased, refunded, or logged in unless the authoritative result reports verification.

Normal HTTP(S) page links are READ_NAVIGATION and should be followed without asking for write confirmation. Downloads are different: do not claim or attempt download handling when the worker reports DOWNLOAD_REQUIRES_HANDLING. If an element is stale or navigation is unverified, observe again and continue only from fresh semantic IDs. A user's “don't ask me” or similar wording never pre-authorizes current or future write actions.

Keep responses concise and answer in the user's language. Never expose private reasoning or internal implementation details.
`.trim();

function plain(content: string, status = 200) {
  return new Response(content, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

function directOpenRequest(message: string, url: string) {
  const withoutUrl = message.replace(url, " ").trim();
  return /^(?:(?:please|can you|could you)\s+)?(?:open|visit|browse|go\s+to)?\s*$/i.test(withoutUrl);
}

function looksLikeCredentialChat(message: string) {
  return /\b(?:password|passcode|pin)\s*(?:is|:|=)|\b(?:username|email)\s*(?:is|:|=).+\bpassword\b/i.test(message);
}

function browserStopResponse(toolResult: unknown) {
  const result = unwrapToolResult(toolResult);
  const status = typeof result?.status === "string" ? result.status : "";
  if (status === "ACTION_NEEDS_CONFIRMATION") {
    const pending = result?.pendingAction as Record<string, unknown> | undefined;
    const phrase = typeof pending?.requiredConfirmationPhrase === "string" ? `\n\nRequired confirmation phrase: ${pending.requiredConfirmationPhrase}` : "";
    return `${typeof result?.message === "string" ? result.message : "This action needs confirmation."}${phrase}`;
  }
  if (["ACTION_UNVERIFIED", "DOWNLOAD_REQUIRES_HANDLING", "AUTH_REQUIRED", "MFA_REQUIRED", "CAPTCHA_REQUIRED", "WORKER_UNAVAILABLE", "URL_BLOCKED", "CONFIRMATION_REJECTED"].includes(status)) {
    return formatBrowserToolResponse(toolResult);
  }
  return null;
}

async function callOllama(
  messages: OllamaTranscriptMessage[],
  tools: ReturnType<typeof getOllamaTools>,
  inference: ReturnType<typeof resolveInference>,
  signal: AbortSignal,
  onStage: (stage: AiTransportStage) => void,
  onHttpError: (diagnostics: Awaited<ReturnType<typeof ollamaHttpErrorDiagnostics>>) => void,
) {
  const requestOptions = inference.options;
  const serializedRequest = JSON.stringify({
    model: inference.model,
    messages,
    tools,
    stream: false,
    think: inference.think,
    keep_alive: -1,
    options: requestOptions,
  });
  onStage("FETCHING_HEADERS");
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(OLLAMA_API_KEY ? { Authorization: `Bearer ${OLLAMA_API_KEY}` } : {}),
    },
    body: serializedRequest,
    signal,
  });
  if (!response.ok) {
    onStage("READING_ERROR_BODY");
    const diagnostics = await ollamaHttpErrorDiagnostics(response, {
      serializedRequest,
      messages,
      toolDefinitionCount: tools.length,
      requestOptions,
      secrets: OLLAMA_API_KEY ? [OLLAMA_API_KEY] : [],
    });
    onHttpError(diagnostics);
    const transcriptInvalid = diagnostics.modelErrorClassification === "MODEL_TRANSCRIPT_INVALID";
    const httpError = new Error(transcriptInvalid ? "The model rejected the internal transcript." : `Ollama returned HTTP ${response.status}.`);
    httpError.name = transcriptInvalid ? "ModelTranscriptInvalidError" : "OllamaHttpError";
    if (transcriptInvalid) Object.assign(httpError, { code: "MODEL_TRANSCRIPT_INVALID" });
    throw httpError;
  }
  onStage("READING_BODY");
  const result = (await response.json().catch((error: unknown) => {
    // JSON parser errors may contain upstream text. Preserve only the transient EOF category.
    if (error instanceof SyntaxError) {
      throw new SyntaxError(/unexpected end of json input/i.test(error.message)
        ? "Unexpected end of JSON input" : "Invalid model response JSON.");
    }
    throw error;
  })) as OllamaResponse;
  onStage("VALIDATING_RESPONSE");
  if (result.error) {
    const applicationError = new Error("The model returned an application error.");
    applicationError.name = "OllamaApplicationError";
    throw applicationError;
  }
  if (!result.message) throw new Error("Ollama returned no assistant message.");
  // Deliberately discard message.thinking before any transcript, tool, or UI handling.
  return { content: result.message.content, tool_calls: result.message.tool_calls };
}

export async function POST(request: Request) {
  const requestStartedAt = Date.now();
  let agentPhase: AgentPhase = "INITIAL_REASONING";
  let agentStep = 0;
  let browserActionCompleted = false;
  let aiTransportStage: AiTransportStage = "NOT_STARTED";
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const reasoningMode = parseReasoningMode(body.reasoningMode);
    const inference = resolveInference(reasoningMode);
    const incoming = body.messages;
    if (!Array.isArray(incoming) || incoming.length === 0) {
      return Response.json({ error: "No conversation messages were provided." }, { status: 400 });
    }
    const messages = incoming.filter((value): value is UserChatMessage =>
      Boolean(value && typeof value === "object" && "role" in value && "content" in value &&
        (value.role === "user" || value.role === "assistant") && typeof value.content === "string"),
    );
    if (!messages.length) return Response.json({ error: "No valid conversation messages were provided." }, { status: 400 });
    const latestMessage = latestActualUserMessage(messages);
    const context = createChatToolContext({ conversationId: body.conversationId, latestUserMessage: latestMessage });

    if (looksLikeCredentialChat(latestMessage)) {
      const state = await observeBrowser(context.conversationId);
      if ("observation" in state && state.observation?.status === "AUTH_REQUIRED") {
        return plain("Do not send login credentials in chat. Use the secure login fields below; they bypass the AI model.");
      }
    }

    const directUrl = requestedBrowserUrl(latestMessage);
    if (directUrl && directOpenRequest(latestMessage, directUrl)) {
      const result = await openBrowserUrl(context.conversationId, directUrl);
      return plain(formatBrowserToolResponse(result));
    }

    const systemMessage = `${KINO_SYSTEM_PROMPT}\n\n${browserRuntimeStateMessage()}`;
    const visibleConversation = messages.map(({ role, content }) => ({ role, content }));
    const toolTranscript: OllamaTranscriptMessage[] = [];
    const tools = getOllamaTools();
    const startedAt = requestStartedAt;
    const duplicateActions = new Map<string, number>();
    const actionHistory: string[] = [];
    let narrationContinuations = 0;
    let continuationReason: ContinuationReason = "TOOL_RESULT";

    for (let round = 1; round <= MAX_BROWSER_STEPS; round += 1) {
      agentStep = round;
      agentPhase = round === 1 ? "INITIAL_REASONING" : "CONTINUATION";
      if (Date.now() - startedAt > MAX_RUNTIME_MS) return plain("KINO stopped because the browser-operation runtime limit was reached.");
      const requestMessages = buildQwenAgentTranscript({
        systemMessage,
        visibleConversation,
        toolTranscript,
        activeUserGoal: latestMessage,
        continuationReason: round === 1 ? undefined : continuationReason,
      });
      let aiRequestAttempt = 0;
      const assistant = await withTransientAiTransportRetry(
        () => {
          const retryAttempt = aiRequestAttempt;
          aiRequestAttempt += 1;
          return callOllama(
            requestMessages,
            tools,
            inference,
            request.signal,
            (stage) => { aiTransportStage = stage; },
            (diagnostics) => console.error("KINO_OLLAMA_HTTP_ERROR", {
              // Never log free-form upstream error text or headers.
              upstreamStatus: diagnostics.upstreamStatus,
              modelErrorClassification: diagnostics.modelErrorClassification,
              requestBytes: diagnostics.requestBytes,
              messageCount: diagnostics.messageCount,
              toolDefinitionCount: diagnostics.toolDefinitionCount,
              configuredNumCtx: diagnostics.configuredNumCtx,
              configuredNumPredict: diagnostics.configuredNumPredict,
              reasoningMode,
              agentPhase,
              agentStep,
              browserActionCompleted,
              elapsedMs: Date.now() - startedAt,
              retryAttempt,
            }),
          );
        },
        {
          signal: request.signal,
          startedAt,
          maxRuntimeMs: MAX_RUNTIME_MS,
          onRetry: (error, retryAttempt) => console.warn("KINO_AI_TRANSPORT_RETRY", {
            ...safeErrorDiagnostics(error),
            agentPhase,
            agentStep,
            browserActionCompleted,
            aiTransportStage,
            elapsedMs: Date.now() - startedAt,
            retryAttempt,
          }),
        },
      );
      const toolCalls = assistant.tool_calls ?? [];
      toolTranscript.push({ role: "assistant", content: assistant.content ?? "", tool_calls: toolCalls.length ? toolCalls : undefined });
      if (!toolCalls.length) {
        agentPhase = "FINAL_SYNTHESIS";
        const content = assistant.content?.trim() ?? "";
        if (shouldContinueSafeBrowserNarration(latestMessage, content, narrationContinuations)) {
          narrationContinuations += 1;
          continuationReason = "NARRATED_SAFE_STEP";
          continue;
        }
        return plain(content || "KINO completed without a final response.");
      }

      // One tool step per round preserves observe → reason → act ordering.
      for (const call of toolCalls.slice(0, 1)) {
        agentPhase = "TOOL_EXECUTION";
        const toolName = call.function.name;
        const args = call.function.arguments ?? {};
        if (toolName.startsWith("web_")) {
          const duplicateKey = `${toolName}:${JSON.stringify(args)}`;
          const duplicateCount = (duplicateActions.get(duplicateKey) ?? 0) + 1;
          duplicateActions.set(duplicateKey, duplicateCount);
          if (duplicateCount >= 3) return plain("KINO stopped because the same browser action repeated without progress.");
          actionHistory.push(duplicateKey);
          if (actionHistory.length >= 6) {
            const recent = actionHistory.slice(-6);
            if (recent[0] === recent[2] && recent[2] === recent[4] && recent[1] === recent[3] && recent[3] === recent[5]) {
              return plain("KINO stopped because browser navigation was cycling without progress.");
            }
          }
        }
        let result: unknown;
        try {
          result = await executeKinoTool(toolName, args, context);
        } catch (error) {
          result = { success: false, status: "ACTION_FAILED", message: error instanceof Error ? error.message : "The tool failed." };
        }
        toolTranscript.push({ role: "tool", tool_name: toolName, content: JSON.stringify(result) });
        continuationReason = "TOOL_RESULT";
        const unwrapped = unwrapToolResult(result);
        if (toolName.startsWith("web_") && ["OPENED", "ACTION_COMPLETED", "AUTH_SUCCESS"].includes(String(unwrapped?.status ?? ""))) {
          browserActionCompleted = true;
        }
        const recoveryStatus = typeof unwrapped?.status === "string" ? unwrapped.status : "";
        if (toolName === "web_action" && ["STALE_ELEMENT", "NAVIGATION_UNVERIFIED"].includes(recoveryStatus)) {
          const refreshed = await executeKinoTool("web_observe", {}, context).catch(() => null);
          if (refreshed) toolTranscript.push({ role: "tool", tool_name: "web_observe", content: JSON.stringify(refreshed) });
        }
        const stop = toolName.startsWith("web_") ? browserStopResponse(result) : null;
        if (stop) return plain(stop);
      }
    }
    return plain(`KINO reached the configured maximum of ${MAX_BROWSER_STEPS} browser steps without completing the goal.`);
  } catch (error) {
    if (error instanceof InferenceConfigurationError) {
      return Response.json({ error: error.message, code: error.code }, {
        status: error.code === "INVALID_REASONING_MODE" ? 400 : 503,
      });
    }
    if (error instanceof Error && error.name === "AbortError") return plain("KINO request cancelled.", 499);
    console.error("KINO_API_ERROR", {
      ...safeErrorDiagnostics(error),
      agentPhase,
      agentStep,
      browserActionCompleted,
      aiTransportStage,
      elapsedMs: Date.now() - requestStartedAt,
    });
    return Response.json({ error: "Unable to communicate with KINO." }, { status: 500 });
  }
}
