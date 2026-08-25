"use client";

import {
  FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type KinoState =
  | "ready"
  | "thinking"
  | "responding"
  | "online"
  | "error";

type ReasoningMode =
  | "fast"
  | "deep";

type SecureFormRequest = {
  secureRequestId: string;
  stage: "awaiting_secure_value" | "awaiting_confirmation";
  fieldName: string;
  expiresInSeconds?: number;
};

function createId() {
  return `${Date.now()}-${Math.random()}`;
}

export default function Home() {
  const [input, setInput] =
    useState("");

  const [messages, setMessages] =
    useState<Message[]>([
      {
        id: "kino-welcome",
        role: "assistant",
        content:
          "Neural core initialized. I am KINO. Awaiting your command.",
      },
    ]);

  const [kinoState, setKinoState] =
    useState<KinoState>("ready");

  const [mode, setMode] =
    useState<ReasoningMode>("fast");

  const [error, setError] =
    useState("");

  const [secureRequest, setSecureRequest] =
    useState<SecureFormRequest | null>(null);

  const [secureValue, setSecureValue] =
    useState("");

  const [secureBusy, setSecureBusy] =
    useState(false);

  const [secureError, setSecureError] =
    useState("");

  const [
    streamingMessageId,
    setStreamingMessageId,
  ] = useState<string | null>(null);

  const inputRef =
    useRef<HTMLInputElement>(null);

  const chatEndRef =
    useRef<HTMLDivElement>(null);

  const conversationIdRef =
    useRef<string | null>(null);

  const secureSubmissionRef =
    useRef(false);

  const isBusy =
    kinoState === "thinking" ||
    kinoState === "responding";

  const isDeepMode =
    mode === "deep";

  const awaitingSecureValue =
    secureRequest?.stage === "awaiting_secure_value";

  async function refreshSecureRequest() {
    const conversationId = conversationIdRef.current;
    if (!conversationId) {
      setSecureRequest(null);
      return;
    }
    try {
      const response = await fetch(
        `/api/kino/secure-form-value?conversationId=${encodeURIComponent(conversationId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const state = await response.json() as {
        exists?: boolean;
        secureRequestId?: string;
        stage?: string;
        fieldName?: string;
        expiresInSeconds?: number;
      };
      if (
        state.exists === true &&
        typeof state.secureRequestId === "string" &&
        typeof state.fieldName === "string" &&
        (state.stage === "awaiting_secure_value" ||
          state.stage === "awaiting_confirmation")
      ) {
        setSecureRequest({
          secureRequestId: state.secureRequestId,
          stage: state.stage,
          fieldName: state.fieldName,
          expiresInSeconds: state.expiresInSeconds,
        });
      } else {
        setSecureRequest(null);
        setSecureValue("");
      }
    } catch {
      // Chat remains usable if safe metadata refresh is temporarily unavailable.
    }
  }

  useEffect(() => {
    if (!secureRequest || !conversationIdRef.current) return;
    const conversationId = conversationIdRef.current;
    const secureRequestId = secureRequest.secureRequestId;
    const discardOnPageExit = () => {
      void fetch("/api/kino/secure-form-value", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, secureRequestId }),
        keepalive: true,
      });
    };
    window.addEventListener("pagehide", discardOnPageExit);
    return () => window.removeEventListener("pagehide", discardOnPageExit);
  }, [secureRequest]);

  /*
    Automatically follow KINO's answer
    while it is being generated.
  */

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({
      behavior:
        streamingMessageId
          ? "auto"
          : "smooth",
    });
  }, [
    messages,
    kinoState,
    streamingMessageId,
  ]);

  async function sendMessage(
    event?: FormEvent
  ) {
    event?.preventDefault();

    const command =
      input.trim();

    if (!command || isBusy) {
      return;
    }

    if (awaitingSecureValue) {
      setInput("");
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          content: `Please use the secure ${secureRequest.fieldName} field so the value does not become part of the AI conversation.`,
        },
      ]);
      return;
    }

    setInput("");
    setError("");
    setKinoState("thinking");

    const userMessage: Message = {
      id: createId(),
      role: "user",
      content: command,
    };

    /*
      Add user message immediately.
    */

    const conversationWithUser = [
      ...messages,
      userMessage,
    ];

    setMessages(
      conversationWithUser
    );

    try {
      conversationIdRef.current ??=
        crypto.randomUUID();

      /*
        We don't need to send our UI IDs
        to Ollama.
      */

      const apiMessages =
        conversationWithUser.map(
          (message) => ({
            role: message.role,
            content:
              message.content,
          })
        );

      const response =
        await fetch("/api/kino", {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body: JSON.stringify({
            messages: apiMessages,

            conversationId:
              conversationIdRef.current,

            think:
              mode === "deep",
          }),
        });

      if (!response.ok) {
        let errorMessage =
          "KINO neural core failed to respond.";

        try {
          const data =
            await response.json();

          if (data.error) {
            errorMessage =
              data.error;
          }
        } catch {
          // Response wasn't JSON.
        }

        throw new Error(
          errorMessage
        );
      }

      if (!response.body) {
        throw new Error(
          "KINO returned no response stream."
        );
      }

      /*
        Create an EMPTY KINO message.

        We will fill this message
        progressively as tokens arrive.
      */

      const kinoMessageId =
        createId();

      const kinoMessage: Message = {
        id: kinoMessageId,
        role: "assistant",
        content: "",
      };

      setMessages((current) => [
        ...current,
        kinoMessage,
      ]);

      setStreamingMessageId(
        kinoMessageId
      );

      /*
        Read KINO's response stream.
      */

      const reader =
        response.body.getReader();

      const decoder =
        new TextDecoder();

      let accumulatedText = "";

      let answerStarted = false;

      let pendingMessageFrame:
        number | null = null;

      const renderAccumulatedText = () => {
        pendingMessageFrame = null;

        setMessages((current) =>
          current.map((message) =>
            message.id ===
            kinoMessageId
              ? {
                  ...message,
                  content:
                    accumulatedText,
                }
              : message
          )
        );
      };

      while (true) {
        const { done, value } =
          await reader.read();

        if (done) {
          break;
        }

        const chunk =
          decoder.decode(
            value,
            {
              stream: true,
            }
          );

        if (!chunk) {
          continue;
        }

        /*
          KINO has finished hidden reasoning
          and has started producing the
          visible final answer.
        */

        if (!answerStarted) {
          answerStarted = true;

          setKinoState(
            "responding"
          );
        }

        accumulatedText +=
          chunk;

        /*
          Batch visible token updates to the
          browser's next paint. This preserves
          every token while avoiding a React
          render for every network chunk.
        */

        if (
          pendingMessageFrame ===
          null
        ) {
          pendingMessageFrame =
            requestAnimationFrame(
              renderAccumulatedText
            );
        }
      }

      const trailingText =
        decoder.decode();

      if (trailingText) {
        accumulatedText +=
          trailingText;
      }

      if (
        pendingMessageFrame !==
        null
      ) {
        cancelAnimationFrame(
          pendingMessageFrame
        );
      }

      renderAccumulatedText();

      /*
        Stream finished.
      */

      if (
        !accumulatedText.trim()
      ) {
        setMessages((current) =>
          current.filter(
            (message) =>
              message.id !==
              kinoMessageId
          )
        );

        throw new Error(
          "KINO completed processing but produced no final answer."
        );
      }

      setStreamingMessageId(
        null
      );

      await refreshSecureRequest();

      setKinoState("online");
    } catch (err) {
      console.error(err);

      setStreamingMessageId(
        null
      );

      const message =
        err instanceof Error
          ? err.message
          : "Unknown connection error.";

      setError(message);

      setKinoState("error");
    } finally {
      setTimeout(() => {
        inputRef.current?.focus();
      }, 100);
    }
  }

  async function submitSecureValue(event: FormEvent) {
    event.preventDefault();
    if (
      !secureRequest ||
      secureRequest.stage !== "awaiting_secure_value" ||
      !conversationIdRef.current ||
      !secureValue ||
      secureSubmissionRef.current
    ) return;

    secureSubmissionRef.current = true;
    setSecureBusy(true);
    setSecureError("");
    const requestPromise = fetch("/api/kino/secure-form-value", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conversationIdRef.current,
        secureRequestId: secureRequest.secureRequestId,
        value: secureValue,
      }),
    });
    setSecureValue("");
    try {
      const response = await requestPromise;
      const result = await response.json() as {
        success?: boolean;
        status?: string;
        fieldName?: string;
        expiresInSeconds?: number;
      };
      if (!response.ok || result.success !== true) {
        throw new Error(
          result.status === "SENSITIVE_VALUE_CONSTRAINT_FAILED"
            ? "The secure value does not satisfy the field constraints."
            : "The secure value could not be staged. Request a new secure field if it expired.",
        );
      }
      const fieldName = result.fieldName ?? secureRequest.fieldName;
      setSecureRequest({
        secureRequestId: secureRequest.secureRequestId,
        stage: "awaiting_confirmation",
        fieldName,
        expiresInSeconds: result.expiresInSeconds,
      });
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          content: `Sensitive value received securely for ${fieldName}. It has not been stored persistently. Confirm to fill it. The form will not be submitted.`,
        },
      ]);
    } catch (secureFailure) {
      setSecureError(
        secureFailure instanceof Error
          ? secureFailure.message
          : "The secure value could not be staged.",
      );
    } finally {
      secureSubmissionRef.current = false;
      setSecureBusy(false);
    }
  }

  async function cancelSecureRequest() {
    if (!secureRequest || !conversationIdRef.current || secureBusy) return;
    const conversationId = conversationIdRef.current;
    const secureRequestId = secureRequest.secureRequestId;
    const fieldName = secureRequest.fieldName;
    setSecureValue("");
    setSecureBusy(true);
    setSecureError("");
    try {
      await fetch("/api/kino/secure-form-value", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, secureRequestId }),
      });
      setSecureRequest(null);
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          content: `Secure entry for ${fieldName} was cancelled. No sensitive value was retained or filled.`,
        },
      ]);
    } catch {
      setSecureError("The secure request could not be cancelled. It will expire automatically.");
    } finally {
      setSecureBusy(false);
    }
  }

  function changeMode(
    newMode: ReasoningMode
  ) {
    if (isBusy) {
      return;
    }

    setMode(newMode);
    setError("");
  }

  function getStatusText() {
    if (
      kinoState === "thinking"
    ) {
      return isDeepMode
        ? "DEEP ANALYSIS"
        : "PROCESSING";
    }

    if (
      kinoState === "responding"
    ) {
      return "RESPONDING";
    }

    if (
      kinoState === "error"
    ) {
      return "CORE ERROR";
    }

    if (isDeepMode) {
      return "DEEP MODE READY";
    }

    return "CORE ONLINE";
  }

  return (
    <main
      className={`kino-chat-app ${
        isDeepMode
          ? "deep-mode-active"
          : ""
      }`}
    >
      <div className="background-grid" />

      {/* =============================
          HEADER
      ============================== */}

      <header className="chat-header">
        <div className="chat-brand">
          <div className="mini-core">
            <div className="mini-core-center" />
          </div>

          <div>
            <h1>KINO</h1>

            <p>
              KNOWLEDGE-INTEGRATED
              NEURAL OPERATOR
            </p>
          </div>
        </div>

        <div className="header-center-status">
          <span
            className={`header-status-dot ${
              kinoState === "error"
                ? "header-error-dot"
                : ""
            }`}
          />

          <div>
            <strong>
              {getStatusText()}
            </strong>

            <span>
              QWEN 3.5 · 4B ·
              OLLAMA LOCAL
            </span>
          </div>
        </div>

        <div className="header-modes">
          <button
            type="button"
            className={`header-mode-button ${
              mode === "fast"
                ? "header-mode-selected"
                : ""
            }`}
            onClick={() =>
              changeMode("fast")
            }
            disabled={isBusy}
          >
            <span>⚡</span>
            FAST
          </button>

          <button
            type="button"
            className={`header-mode-button ${
              mode === "deep"
                ? "header-mode-selected header-deep-selected"
                : ""
            }`}
            onClick={() =>
              changeMode("deep")
            }
            disabled={isBusy}
          >
            <span>◉</span>
            DEEP THINK
          </button>
        </div>
      </header>

      {/* =============================
          CHAT WORKSPACE
      ============================== */}

      <section className="chat-workspace">
        <div className="chat-inner">
          {messages.map(
            (message) => {
              const isUser =
                message.role ===
                "user";

              const isStreaming =
                message.id ===
                streamingMessageId;

              return (
                <div
                  key={message.id}
                  className={`chat-row ${
                    isUser
                      ? "chat-row-user"
                      : "chat-row-kino"
                  }`}
                >
                  {!isUser && (
                    <div
                      className={`message-avatar kino-avatar ${
                        isStreaming
                          ? "active-avatar"
                          : ""
                      }`}
                    >
                      K
                    </div>
                  )}

                  <div
                    className={`message-group ${
                      isUser
                        ? "message-group-user"
                        : "message-group-kino"
                    }`}
                  >
                    <div className="message-meta">
                      {isUser
                        ? "YOU"
                        : "KINO"}
                    </div>

                    <div
                      className={`message-bubble ${
                        isUser
                          ? "user-bubble"
                          : "kino-bubble"
                      } ${
                        isStreaming
                          ? "streaming-bubble"
                          : ""
                      }`}
                    >
                      {message.content}

                      {isStreaming && (
                        <span className="typing-cursor">
                          ▌
                        </span>
                      )}
                    </div>
                  </div>

                  {isUser && (
                    <div className="message-avatar user-avatar">
                      Y
                    </div>
                  )}
                </div>
              );
            }
          )}

          {secureRequest && (
            <div className="chat-row chat-row-kino secure-entry-row">
              <div className="message-avatar kino-avatar">K</div>
              <div className="secure-entry-card" aria-live="polite">
                <div className="secure-entry-heading">
                  <div>
                    <span>SECURE VALUE REQUIRED</span>
                    <strong>{secureRequest.fieldName}</strong>
                  </div>
                  <span className="secure-entry-badge">MEMORY ONLY</span>
                </div>

                {secureRequest.stage === "awaiting_secure_value" ? (
                  <form onSubmit={submitSecureValue}>
                    <label htmlFor="kino-secure-form-value">
                      Enter this value securely. It will not be added to chat or sent to the AI model.
                    </label>
                    <input
                      id="kino-secure-form-value"
                      type="password"
                      value={secureValue}
                      onChange={(event) => setSecureValue(event.target.value)}
                      disabled={secureBusy}
                      autoComplete="new-password"
                      name="kino-secure-ephemeral-value"
                      data-lpignore="true"
                      data-1p-ignore="true"
                      spellCheck={false}
                      aria-label={`Secure ${secureRequest.fieldName} value`}
                    />
                    <div className="secure-entry-actions">
                      <button
                        type="submit"
                        disabled={secureBusy || secureValue.length === 0}
                      >
                        {secureBusy ? "STAGING..." : "USE SECURELY"}
                      </button>
                      <button
                        type="button"
                        className="secure-cancel-button"
                        onClick={cancelSecureRequest}
                        disabled={secureBusy}
                      >
                        CANCEL
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="secure-entry-staged">
                    <span aria-hidden="true">✓</span>
                    <p>
                      Sensitive value received securely. Confirm in chat to fill this field.
                    </p>
                    <button
                      type="button"
                      className="secure-cancel-button"
                      onClick={cancelSecureRequest}
                      disabled={secureBusy}
                    >
                      CANCEL
                    </button>
                  </div>
                )}

                {secureError && (
                  <p className="secure-entry-error" role="alert">{secureError}</p>
                )}
                <small>Expires shortly. The form will not be submitted.</small>
              </div>
            </div>
          )}

          {/* Show this only BEFORE
              final answer starts */}

          {kinoState ===
            "thinking" && (
            <div className="chat-row chat-row-kino">
              <div className="message-avatar kino-avatar active-avatar">
                K
              </div>

              <div className="message-group message-group-kino">
                <div className="message-meta">
                  KINO
                </div>

                <div
                  className={`message-bubble kino-bubble thinking-bubble ${
                    isDeepMode
                      ? "deep-thinking-bubble"
                      : ""
                  }`}
                >
                  <div className="thinking-line">
                    <span>
                      {isDeepMode
                        ? "Performing deep analysis"
                        : "Processing"}
                    </span>

                    <div className="chat-thinking-dots">
                      <i />
                      <i />
                      <i />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="chat-error">
              <span>
                CORE ERROR
              </span>

              {error}
            </div>
          )}

          <div ref={chatEndRef} />
        </div>
      </section>

      {/* =============================
          COMMAND AREA
      ============================== */}

      <section className="command-section">
        <form
          className="command-container"
          onSubmit={sendMessage}
        >
          <div className="command-top">
            <span className="command-mode">
              {isDeepMode
                ? "◉ DEEP REASONING"
                : "⚡ FAST RESPONSE"}
            </span>

            <span className="command-status">
              LOCAL AI · NO CLOUD API
            </span>
          </div>

          <div className="command-input-row">
            <input
              ref={inputRef}
              value={input}
              onChange={(event) =>
                setInput(
                  event.target.value
                )
              }
              placeholder={
                kinoState ===
                "thinking"
                  ? isDeepMode
                    ? "KINO is performing deep analysis..."
                    : "KINO is processing..."
                  : kinoState ===
                      "responding"
                    ? "KINO is responding..."
                    : awaitingSecureValue
                      ? `Use the secure ${secureRequest?.fieldName ?? "value"} field above...`
                      : "Message KINO..."
              }
              disabled={isBusy || awaitingSecureValue}
              autoComplete="off"
            />

            <button
              type="submit"
              disabled={
                isBusy ||
                awaitingSecureValue ||
                !input.trim()
              }
            >
              {isBusy ? (
                <span className="send-loader" />
              ) : (
                <>
                  SEND

                  <span className="send-arrow">
                    ↑
                  </span>
                </>
              )}
            </button>
          </div>

          <p className="command-hint">
            KINO can analyze
            operational data,
            customers, sales and
            connected business
            systems.
          </p>
        </form>
      </section>

      {/* =============================
          FOOTER
      ============================== */}

      <footer className="chat-footer">
        <span>
          KINO · BUILD 0.5
        </span>

        <span>
          DEVELOPED BY
          BAKR EL ACHKAR
        </span>

        <span>
          LOCAL NEURAL SYSTEM
        </span>
      </footer>
    </main>
  );
}
