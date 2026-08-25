export type KinoToolRisk =
  | "read"
  | "write"
  | "critical";

export type KinoToolParameter = {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  enum?: string[];
  properties?: Record<string, KinoToolParameter>;
  required?: string[];
  items?: KinoToolParameter;
};

export type KinoToolSchema = {
  type: "object";

  properties: Record<
    string,
    KinoToolParameter
  >;

  required?: string[];
};

export type KinoToolContext = {
  requestedAt: Date;
  conversationId: string;
  latestUserMessage: string;
  source: "chat" | "manual";
};

export type KinoTool = {
  /*
    Unique name visible to the AI.

    Examples:

    cleannest_get_bookings
    storeflow_get_inventory
  */
  name: string;

  /*
    Tells KINO when this tool should
    be selected.
  */
  description: string;

  /*
    Which integration owns the tool.
  */
  integration: string;

  /*
    READ:
    retrieves information only.

    WRITE:
    changes application data.

    CRITICAL:
    sensitive actions such as refunds,
    deletion, etc.
  */
  risk: KinoToolRisk;

  /*
    WRITE tools remain blocked unless they opt into this narrowly scoped
    policy and independently validate real chat context server-side.
  */
  executionPolicy?: "server-confirmed";

  /*
    JSON schema Ollama receives.
  */
  parameters: KinoToolSchema;

  /*
    Actual application code executed
    when KINO chooses this tool.
  */
  execute: (
    args: Record<string, unknown>,
    context: KinoToolContext
  ) => Promise<unknown>;
};

export type OllamaToolDefinition = {
  type: "function";

  function: {
    name: string;

    description: string;

    parameters: KinoToolSchema;
  };
};
