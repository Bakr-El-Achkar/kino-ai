/*
  Importing builtin.ts registers
  KINO's built-in tools.
*/

import "./builtin";
import "./web-agent";

export {
  executeKinoTool,
  getOllamaTools,
  getRegisteredTools,
} from "./registry";
export {
  createChatToolContext,
  createManualToolContext,
  latestActualUserMessage,
  isValidConversationId,
  resolveConversationId,
  safeConversationScope,
} from "./execution-context";

export type {
  KinoTool,
  KinoToolRisk,
} from "./types";
