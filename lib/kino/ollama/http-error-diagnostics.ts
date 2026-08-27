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
  if (jsonContentType(upstreamContentType)) {
    const payload = await response.json().catch(() => null) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload) && "error" in payload) {
      if (typeof payload.error === "string") {
        ollamaError = redactSensitiveText(payload.error, sensitiveValues);
      } else if (payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)) {
        ollamaErrorMessage = safeDiagnosticScalar("message" in payload.error ? payload.error.message : undefined, sensitiveValues);
        ollamaErrorCode = safeDiagnosticScalar("code" in payload.error ? payload.error.code : undefined, sensitiveValues);
        ollamaErrorType = safeDiagnosticScalar("type" in payload.error ? payload.error.type : undefined, sensitiveValues);
        ollamaErrorStatus = safeDiagnosticScalar("status" in payload.error ? payload.error.status : undefined, sensitiveValues);
        ollamaErrorStatusCode = safeDiagnosticScalar("status_code" in payload.error ? payload.error.status_code : undefined, sensitiveValues);
        ollamaErrorReason = safeDiagnosticScalar("reason" in payload.error ? payload.error.reason : undefined, sensitiveValues);
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
    ...ollamaRequestDiagnostics(options.serializedRequest, options.messages, options.toolDefinitionCount, options.requestOptions),
  };
}
