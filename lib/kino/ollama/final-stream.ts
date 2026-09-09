import { CHAT_STREAM_HEADERS, encodeChatEvent, readNdjson, type ChatStreamEvent } from "../chat-stream.ts";
import type { OllamaToolCall } from "./transcript.ts";

type Publish = (event: ChatStreamEvent) => void;

// One response encloses the existing agent loop; this helper never calls the model.
export function streamChatResponse(
  requestSignal: AbortSignal,
  remainingMs: number,
  run: (publish: Publish, signal: AbortSignal) => Promise<void>,
) {
  const controller = new AbortController();
  const signal = AbortSignal.any([requestSignal, controller.signal, AbortSignal.timeout(Math.max(1, remainingMs))]);
  return new Response(new ReadableStream<Uint8Array>({
    async start(output) {
      const publish: Publish = event => {
        signal.throwIfAborted();
        output.enqueue(encodeChatEvent(event));
      };
      try {
        publish({ type: "start" });
        await run(publish, signal);
        publish({ type: "done" });
      } catch {
        if (!requestSignal.aborted && !controller.signal.aborted) {
          output.enqueue(encodeChatEvent({ type: "error", code: "STREAM_INTERRUPTED", message: "KINO could not complete the response." }));
        }
      } finally {
        if (!controller.signal.aborted) output.close();
        controller.abort();
      }
    },
    cancel() { controller.abort(); },
  }), { headers: CHAT_STREAM_HEADERS });
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Ollama native NDJSON supplies structured argument objects, not OpenAI argument strings.
// Accumulate whole tool records across chunks; reject incomplete/conflicting calls.
function validateCalls(values: unknown[], allowedTools: ReadonlySet<string>): OllamaToolCall[] {
  const calls = new Map<number, OllamaToolCall>();
  for (const value of values) {
    if (!record(value) || !record(value.function)) throw new Error("Invalid model tool call.");
    const fn = value.function;
    if (typeof fn.name !== "string" || !allowedTools.has(fn.name) || !record(fn.arguments)) {
      throw new Error("Invalid model tool call.");
    }
    const index = fn.index ?? value.index ?? calls.size;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0) throw new Error("Invalid tool index.");
    const call: OllamaToolCall = { function: { name: fn.name, arguments: fn.arguments } };
    const previous = calls.get(index);
    if (previous && JSON.stringify(previous) !== JSON.stringify(call)) throw new Error("Conflicting tool call fragments.");
    calls.set(index, call);
  }
  return [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
}

export async function readOllamaRound(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  allowedTools: ReadonlySet<string>,
  publish: Publish,
) {
  let content = "";
  let toolRound = false;
  let complete = false;
  const pendingCalls: unknown[] = [];
  for await (const value of readNdjson(body, signal)) {
    if (!record(value)) throw new Error("Invalid model event.");
    if (value.error) throw new Error("Model generation failed.");
    if (value.message !== undefined && !record(value.message)) throw new Error("Invalid model message.");
    const message = value.message as Record<string, unknown> | undefined;
    if (message?.tool_calls !== undefined) {
      if (!Array.isArray(message.tool_calls)) throw new Error("Invalid model tool calls.");
      if (message.tool_calls.length) {
        if (!toolRound) publish({ type: "reset" });
        toolRound = true;
        pendingCalls.push(...message.tool_calls);
        if (pendingCalls.length > 64) throw new Error("Too many model tool calls.");
      }
    }
    // Allowlist content only. Never retain, log, publish, or add thinking to transcripts.
    if (message?.content !== undefined && typeof message.content !== "string") throw new Error("Invalid model content.");
    if (typeof message?.content === "string" && message.content) {
      content += message.content;
      if (!toolRound) publish({ type: "delta", content: message.content });
    }
    if (value.done === true) {
      if (toolRound && value.done_reason === "length") throw new Error("Truncated tool round.");
      complete = true;
      break;
    }
  }
  if (!complete) throw new Error("Incomplete model stream.");
  signal.throwIfAborted();
  // No tool data is returned to the executor until the full round has ended and validated.
  return { content, tool_calls: validateCalls(pendingCalls, allowedTools) };
}
