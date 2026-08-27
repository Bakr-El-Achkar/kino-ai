type MessageLike = { content?: unknown };
type OllamaRequestOptionsLike = { num_ctx?: unknown; num_predict?: unknown };
type DiagnosticScalar = string | number | boolean;

function boundedHeader(value: string | null, sensitiveValues: readonly string[], maximumLength = 200) {
  return value ? redactSensitiveText(value.replace(/[\r\n]/g, " "), sensitiveValues).slice(0, maximumLength) || undefined : undefined;
}

function jsonContentType(contentType: string | undefined) {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function redactSensitiveText(value: string, sensitiveValues: readonly string[]) {
  let safe = value
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(/bearer\s+\S+/gi, "Bearer [REDACTED]");
  const fragments = new Set<string>();
  for (const sensitiveValue of sensitiveValues) {
    if (!sensitiveValue) continue;
    if (sensitiveValue.length >= 8) fragments.add(sensitiveValue);
    for (const fragment of sensitiveValue.match(/[\p{L}\p{N}_\-.]{8,}/gu) ?? []) fragments.add(fragment);
  }
  for (const fragment of fragments) safe = safe.replaceAll(fragment, "[REDACTED]");
  return safe.slice(0, 500);
}

function safeDiagnosticScalar(value: unknown, sensitiveValues: readonly string[]): DiagnosticScalar | undefined {
  if (typeof value === "string") return redactSensitiveText(value, sensitiveValues);
  return typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

function finiteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function ollamaRequestDiagnostics(
  serializedRequest: string,
  messages: readonly MessageLike[],
  toolDefinitionCount: number,
  requestOptions: OllamaRequestOptionsLike = {},
) {
  return {
    requestBytes: new TextEncoder().encode(serializedRequest).byteLength,
    messageCount: messages.length,
    toolDefinitionCount,
    messageContentCharacters: messages.reduce((total, message) =>
      total + (typeof message.content === "string" ? message.content.length : 0), 0),
    configuredNumCtx: finiteNumber(requestOptions.num_ctx),
    configuredNumPredict: finiteNumber(requestOptions.num_predict),
  };
}

export async function ollamaHttpErrorDiagnostics(
  response: Response,
  options: {
    serializedRequest: string;
    messages: readonly MessageLike[];
    toolDefinitionCount: number;
    requestOptions?: OllamaRequestOptionsLike;
    secrets?: readonly string[];
  },
) {
  const sensitiveValues = [
    ...(options.secrets ?? []),
    ...options.messages.flatMap((message) => typeof message.content === "string" ? [message.content] : []),
  ];
  const upstreamContentType = boundedHeader(response.headers.get("content-type"), sensitiveValues);
  let ollamaError: string | undefined;
  let ollamaErrorMessage: DiagnosticScalar | undefined;
  let ollamaErrorCode: DiagnosticScalar | undefined;
  let ollamaErrorType: DiagnosticScalar | undefined;
  let ollamaErrorStatus: DiagnosticScalar | undefined;
  let ollamaErrorStatusCode: DiagnosticScalar | undefined;
  let ollamaErrorReason: DiagnosticScalar | undefined;
  let transcriptInvalid = false;
  if (jsonContentType(upstreamContentType)) {
    const payload = await response.json().catch(() => null) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload) {
      if (typeof payload.error === "string") {
        transcriptInvalid = /no user query found in messages/i.test(payload.error);
        ollamaError = redactSensitiveText(payload.error, sensitiveValues);
      } else if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
        const errorObject = payload.error as Record<string, unknown>;
        transcriptInvalid = ["message", "code", "type", "status", "status_code", "reason"].some((field) =>
          typeof errorObject[field] === "string" && /no user query found in messages/i.test(errorObject[field]));
        ollamaErrorMessage = safeDiagnosticScalar(errorObject.message, sensitiveValues);
        ollamaErrorCode = safeDiagnosticScalar(errorObject.code, sensitiveValues);
        ollamaErrorType = safeDiagnosticScalar(errorObject.type, sensitiveValues);
        ollamaErrorStatus = safeDiagnosticScalar(errorObject.status, sensitiveValues);
        ollamaErrorStatusCode = safeDiagnosticScalar(errorObject.status_code, sensitiveValues);
        ollamaErrorReason = safeDiagnosticScalar(errorObject.reason, sensitiveValues);
      }
    }
  }
  const contentLengthHeader = response.headers.get("content-length");
  const parsedContentLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader)
    ? Number.parseInt(contentLengthHeader, 10)
    : undefined;
  return {
    upstreamStatus: response.status,
    upstreamStatusText: boundedHeader(response.statusText, sensitiveValues),
    upstreamContentType,
    upstreamContentLength: Number.isSafeInteger(parsedContentLength) ? parsedContentLength : undefined,
    ollamaError,
    ollamaErrorMessage,
    ollamaErrorCode,
    ollamaErrorType,
    ollamaErrorStatus,
    ollamaErrorStatusCode,
    ollamaErrorReason,
    modelErrorClassification: transcriptInvalid ? "MODEL_TRANSCRIPT_INVALID" as const : undefined,
    ...ollamaRequestDiagnostics(options.serializedRequest, options.messages, options.toolDefinitionCount, options.requestOptions),
  };
}
