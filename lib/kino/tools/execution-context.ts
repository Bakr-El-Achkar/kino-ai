import { createHash, randomUUID } from "node:crypto";

import type { KinoToolContext } from "./types";

const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value);
}

export function resolveConversationId(value: unknown) {
  return isValidConversationId(value)
    ? value.toLowerCase()
    : randomUUID();
}

export function safeConversationScope(conversationId: string) {
  return createHash("sha256").update(conversationId).digest("hex").slice(0, 16);
}

export function latestActualUserMessage(
  messages: Array<{ role: string; content: string }>,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && typeof message.content === "string") {
      return message.content.trim();
    }
  }
  return "";
}

export function createChatToolContext({
  conversationId,
  latestUserMessage,
}: {
  conversationId: unknown;
  latestUserMessage: string;
}): KinoToolContext {
  const resolvedConversationId = resolveConversationId(conversationId);
  console.log("KINO_CONVERSATION_SCOPE", {
    scope: safeConversationScope(resolvedConversationId),
  });
  return {
    requestedAt: new Date(),
    conversationId: resolvedConversationId,
    latestUserMessage,
    source: "chat",
  };
}

export function createManualToolContext(): KinoToolContext {
  return {
    requestedAt: new Date(),
    conversationId: randomUUID(),
    latestUserMessage: "",
    source: "manual",
  };
}
