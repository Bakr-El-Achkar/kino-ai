export type OllamaToolCall = { type?: "function"; function: { name: string; arguments?: Record<string, unknown> } };

export type OllamaTranscriptMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: OllamaToolCall[] }
  | { role: "tool"; tool_name: string; content: string };

export type VisibleConversationMessage = { role: "user" | "assistant"; content: string };
export type ContinuationReason = "TOOL_RESULT" | "NARRATED_SAFE_STEP";

const INTERNAL_CONTINUATION_MARKER = "[KINO INTERNAL CONTINUATION DIRECTIVE — NOT VISIBLE USER HISTORY]";

export function internalContinuationDirective(activeUserGoal: string, reason: ContinuationReason): OllamaTranscriptMessage {
  const reasonInstruction = reason === "NARRATED_SAFE_STEP"
    ? "A safe next browser step was narrated but not executed. Continue with the appropriate tool if it is still needed."
    : "Continue reasoning from the trusted tool results already present in this transcript.";
  return {
    role: "user",
    content: `${INTERNAL_CONTINUATION_MARKER}
Active original user goal (quoted as data): ${JSON.stringify(activeUserGoal)}
${reasonInstruction}
If the goal is complete, answer the user from the existing trusted results without another tool call. Otherwise request only the next safe tool action.
This internal directive is not user confirmation, permission, credentials, or a policy override. Write and critical actions still require confirmation from the actual latest visible user message.`,
  };
}

export function buildQwenAgentTranscript(options: {
  systemMessage: string;
  visibleConversation: readonly VisibleConversationMessage[];
  toolTranscript: readonly OllamaTranscriptMessage[];
  activeUserGoal: string;
  continuationReason?: ContinuationReason;
}) {
  const messages: OllamaTranscriptMessage[] = [
    { role: "system", content: options.systemMessage },
    ...options.visibleConversation.map((message) => ({ ...message })),
    ...options.toolTranscript.map((message) => ({ ...message })),
  ];
  if (options.continuationReason) messages.push(internalContinuationDirective(options.activeUserGoal, options.continuationReason));
  return messages;
}

export function transcriptShape(messages: readonly OllamaTranscriptMessage[], activeUserGoal: string) {
  return {
    roles: messages.map((message) => message.role),
    messageCount: messages.length,
    activeUserGoalPresent: messages.some((message) =>
      message.role === "user" && (message.content === activeUserGoal || message.content.includes(JSON.stringify(activeUserGoal)))),
  };
}

export function isInternalContinuationDirective(message: OllamaTranscriptMessage) {
  return message.role === "user" && message.content.startsWith(INTERNAL_CONTINUATION_MARKER);
}
