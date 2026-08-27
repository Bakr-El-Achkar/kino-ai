type MessageLike = { content?: unknown };

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

export function ollamaRequestDiagnostics(
  serializedRequest: string,
  messages: readonly MessageLike[],
  toolDefinitionCount: number,
) {
  return {
    requestBytes: new TextEncoder().encode(serializedRequest).byteLength,
    messageCount: messages.length,
    toolDefinitionCount,
    messageContentCharacters: messages.reduce((total, message) =>
      total + (typeof message.content === "string" ? message.content.length : 0), 0),
  };
}

export async function ollamaHttpErrorDiagnostics(
  response: Response,
  options: {
    serializedRequest: string;
    messages: readonly MessageLike[];
    toolDefinitionCount: number;
    secrets?: readonly string[];
  },
) {
  const sensitiveValues = [
    ...(options.secrets ?? []),
    ...options.messages.flatMap((message) => typeof message.content === "string" ? [message.content] : []),
  ];
  const upstreamContentType = boundedHeader(response.headers.get("content-type"), sensitiveValues);
  let ollamaError: string | undefined;
  if (jsonContentType(upstreamContentType)) {
    const payload = await response.json().catch(() => null) as unknown;
    if (payload && typeof payload === "object" && !Array.isArray(payload) &&
      "error" in payload && typeof payload.error === "string") {
      ollamaError = redactSensitiveText(payload.error, sensitiveValues);
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
    ...ollamaRequestDiagnostics(options.serializedRequest, options.messages, options.toolDefinitionCount),
  };
}
