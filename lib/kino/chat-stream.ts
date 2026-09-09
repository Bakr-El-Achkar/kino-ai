import { parseActivity, type Activity } from "./activity.ts";

export type ChatStreamEvent =
  | ({ type: "status" } & Activity)
  | { type: "start" }
  | { type: "delta"; content: string }
  | { type: "reset" }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

export const CHAT_STREAM_HEADERS = {
  "Content-Type": "application/x-ndjson; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
};

export function encodeChatEvent(event: ChatStreamEvent) {
  return new TextEncoder().encode(`${JSON.stringify(event)}\n`);
}

// Shared framing only: neither side ever treats network chunks as whole JSON records.
export async function* readNdjson(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  const parse = (line: string): unknown => {
    try { return JSON.parse(line); }
    catch { throw new Error("Invalid streaming response."); }
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      signal?.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line.length > 1_048_576) throw new Error("Streaming record too large.");
        if (line) yield parse(line);
      }
      if (pending.length > 1_048_576) throw new Error("Streaming record too large.");
      if (done) {
        if (pending.trim()) yield parse(pending);
        break;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (content: string) => void,
  signal?: AbortSignal,
  onReset: () => void = () => {},
  onStatus: (activity: Activity) => void = () => {},
) {
  let started = false;
  for await (const value of readNdjson(body, signal)) {
    if (!value || typeof value !== "object") throw new Error("Invalid chat stream.");
    const event = value as Record<string, unknown>;
    if (event.type === "start" && !started) { started = true; continue; }
    if (!started) throw new Error("Invalid chat stream.");
    if (event.type === "status") {
      const activity = parseActivity(event);
      if (!activity) throw new Error("Invalid activity status.");
      onStatus(activity);
      continue;
    }
    if (event.type === "delta" && typeof event.content === "string") { onDelta(event.content); continue; }
    if (event.type === "reset") { onReset(); continue; }
    if (event.type === "done") return;
    // Do not reflect arbitrary upstream error text or unexpected fields into the UI.
    if (event.type === "error") throw new Error("Response interrupted. The text received so far has been kept.");
    throw new Error("Invalid chat stream.");
  }
  throw new Error("Response interrupted before completion. The text received so far has been kept.");
}
