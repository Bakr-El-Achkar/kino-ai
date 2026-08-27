export type AgentPhase = "INITIAL_REASONING" | "TOOL_EXECUTION" | "CONTINUATION" | "FINAL_SYNTHESIS";

type ErrorLike = {
  name?: unknown;
  message?: unknown;
  code?: unknown;
  cause?: unknown;
};

const TRANSIENT_MESSAGE = /(?:^terminated$|premature\s+(?:eof|close)|unexpected end of json input|socket (?:closed|hang up)|other side closed|connection (?:reset|closed)|read econnreset)/i;
const TRANSIENT_CODE = new Set(["ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

function errorLike(value: unknown): ErrorLike | null {
  return value && typeof value === "object" ? value as ErrorLike : null;
}

function diagnosticText(value: unknown) {
  return typeof value === "string"
    ? value
      .replace(/https?:\/\/\S+/gi, "[URL]")
      .replace(/bearer\s+\S+/gi, "Bearer [REDACTED]")
      .slice(0, 300)
    : undefined;
}

export function safeErrorDiagnostics(error: unknown) {
  const outer = errorLike(error);
  const cause = errorLike(outer?.cause);
  return {
    errorName: diagnosticText(outer?.name) ?? (error instanceof Error ? error.name : typeof error),
    errorMessage: diagnosticText(outer?.message) ?? (error instanceof Error ? diagnosticText(error.message) : "Unknown error"),
    causeName: diagnosticText(cause?.name),
    causeMessage: diagnosticText(cause?.message),
    causeCode: diagnosticText(cause?.code) ?? diagnosticText(outer?.code),
  };
}

export function isTransientAiTransportError(error: unknown) {
  const outer = errorLike(error);
  if (!outer) return false;
  if (outer.name === "AbortError" || outer.name === "OllamaApplicationError") return false;
  const cause = errorLike(outer.cause);
  const messages = [outer.message, cause?.message].filter((value): value is string => typeof value === "string");
  const codes = [outer.code, cause?.code].filter((value): value is string => typeof value === "string");
  return messages.some((message) => {
    if (/unexpected end of json input/i.test(message)) return outer.name === "SyntaxError";
    return TRANSIENT_MESSAGE.test(message);
  }) || codes.some((code) => TRANSIENT_CODE.has(code.toUpperCase()));
}

function abortError() {
  return new DOMException("The request was aborted.", "AbortError");
}

async function boundedBackoff(milliseconds: number, signal: AbortSignal) {
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withTransientAiTransportRetry<T>(
  operation: () => Promise<T>,
  options: {
    signal: AbortSignal;
    startedAt: number;
    maxRuntimeMs: number;
    maxRetries?: number;
    backoffMs?: number;
    onRetry?: (error: unknown, retryAttempt: number) => void;
  },
) {
  const maxRetries = options.maxRetries ?? 1;
  const backoffMs = options.backoffMs ?? 200;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryAttempt = attempt + 1;
      const elapsedMs = Date.now() - options.startedAt;
      if (!isTransientAiTransportError(error) || retryAttempt > maxRetries || elapsedMs + backoffMs >= options.maxRuntimeMs) throw error;
      options.onRetry?.(error, retryAttempt);
      await boundedBackoff(backoffMs, options.signal);
    }
  }
}
