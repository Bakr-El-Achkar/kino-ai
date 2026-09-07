export type ReasoningMode = "normal" | "thinking";

export class InferenceConfigurationError extends Error {
  code: "INVALID_REASONING_MODE" | "THINKING_MODEL_NOT_CONFIGURED";
  constructor(code: "INVALID_REASONING_MODE" | "THINKING_MODEL_NOT_CONFIGURED") {
    super(code === "INVALID_REASONING_MODE"
      ? "Invalid reasoning mode."
      : "Thinking mode is not configured.");
    this.name = "InferenceConfigurationError";
    this.code = code;
  }
}

export function parseReasoningMode(value: unknown): ReasoningMode {
  if (value === undefined) return "normal";
  if (value === "normal" || value === "thinking") return value;
  throw new InferenceConfigurationError("INVALID_REASONING_MODE");
}

function budget(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Only the server calls this function; the client imports the mode type only.
export function resolveInference(mode: ReasoningMode, env: NodeJS.ProcessEnv = process.env) {
  const thinking = mode === "thinking";
  const model = thinking ? env.OLLAMA_THINKING_MODEL?.trim() : env.OLLAMA_MODEL ?? "kino-optimized";
  if (!model && thinking) throw new InferenceConfigurationError("THINKING_MODEL_NOT_CONFIGURED");
  return {
    model,
    think: thinking,
    options: {
      num_ctx: budget(thinking ? env.KINO_THINK_NUM_CTX : env.KINO_NUM_CTX, 8192),
      num_predict: budget(thinking ? env.KINO_THINK_NUM_PREDICT : env.KINO_NUM_PREDICT, thinking ? 2048 : 1024),
    },
  };
}
