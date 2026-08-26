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

type LoginChallenge = {
  usernameLabel?: string;
  passwordLabel?: string;
};

function createId() {
  return `${Date.now()}-${Math.random()}`;
}

function renderMessageContent(content: string) {
  return content.split(/(https?:\/\/[^\s<]+)/g).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    const url = part.replace(/[.,!?;:)}\]]+$/, "");
    const trailing = part.slice(url.length);
    return (
      <span key={`${url}-${index}`}>
        <a href={url} target="_blank" rel="noopener noreferrer">
          {url}
        </a>
        {trailing}
      </span>
    );
  });
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

  const [loginChallenge, setLoginChallenge] =
    useState<LoginChallenge | null>(null);

  const [loginUsername, setLoginUsername] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState("");

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

  const isBusy =
    kinoState === "thinking" ||
    kinoState === "responding";

  const isDeepMode =
    mode === "deep";

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

  async function refreshBrowserState() {
    const conversationId = conversationIdRef.current;
    if (!conversationId) return;
    try {
      const response = await fetch(
        `/api/kino/browser-state?conversationId=${encodeURIComponent(conversationId)}`,
        { cache: "no-store" },
      );
      if (!response.ok) return;
      const state = await response.json() as {
        observation?: {
          status?: string;
          authentication?: LoginChallenge;
        };
      };
      if (state.observation?.status === "AUTH_REQUIRED") {
        setLoginChallenge(state.observation.authentication ?? {});
      } else {
        setLoginChallenge(null);
      }
    } catch {
      // Browser operations remain optional; ordinary chat must stay usable.
    }
  }

  async function sendMessage(
    event?: FormEvent
  ) {
    event?.preventDefault();

    const command =
      input.trim();

    if (!command || isBusy) {
      return;
    }

    if (
      loginChallenge &&
      /\b(?:password|passcode|pin)\s*(?:is|:|=)|\b(?:username|email)\s*(?:is|:|=).+\bpassword\b/i.test(command)
    ) {
      setInput("");
      setMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          content: "Do not type credentials into chat. Use the secure login fields below; they bypass the AI model.",
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

      await refreshBrowserState();

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

  async function submitSecureLogin(event: FormEvent) {
    event.preventDefault();
    if (!conversationIdRef.current || !loginUsername || !loginPassword || loginBusy) return;
    setLoginBusy(true);
    setLoginError("");
    const request = fetch("/api/kino/browser-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: conversationIdRef.current,
        username: loginUsername,
        password: loginPassword,
      }),
    });
    setLoginUsername("");
    setLoginPassword("");
    try {
      const response = await request;
      const result = await response.json() as { success?: boolean; status?: string; message?: string };
      if (result.status === "MFA_REQUIRED" || result.status === "CAPTCHA_REQUIRED") {
        setLoginError("Human verification is required in the browser session.");
      } else if (!response.ok || result.success !== true || result.status !== "AUTH_SUCCESS") {
        setLoginError(result.message || "Authentication failed. Check the credentials and try again.");
      } else {
        setLoginChallenge(null);
        setMessages((current) => [
          ...current,
          { id: createId(), role: "assistant", content: "Login succeeded and the authenticated browser session is ready." },
        ]);
      }
    } catch {
      setLoginError("The secure login service is currently unavailable.");
    } finally {
      setLoginBusy(false);
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
                      {renderMessageContent(message.content)}

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

          {loginChallenge && (
            <div className="chat-row chat-row-kino secure-login-row">
              <div className="message-avatar kino-avatar">K</div>
              <form className="secure-login-card" onSubmit={submitSecureLogin}>
                <div className="secure-login-heading">
                  <div>
                    <span>SECURE BROWSER LOGIN</span>
                    <strong>Credentials bypass the AI model</strong>
                  </div>
                  <span className="secure-login-badge">WORKER ONLY</span>
                </div>
                <label htmlFor="kino-login-username">
                  {loginChallenge.usernameLabel || "Username / Email"}
                </label>
                <input
                  id="kino-login-username"
                  type="text"
                  value={loginUsername}
                  onChange={(event) => setLoginUsername(event.target.value)}
                  autoComplete="username"
                  disabled={loginBusy}
                />
                <label htmlFor="kino-login-password">
                  {loginChallenge.passwordLabel || "Password"}
                </label>
                <input
                  id="kino-login-password"
                  type="password"
                  value={loginPassword}
                  onChange={(event) => setLoginPassword(event.target.value)}
                  autoComplete="current-password"
                  disabled={loginBusy}
                />
                <button type="submit" disabled={loginBusy || !loginUsername || !loginPassword}>
                  {loginBusy ? "SIGNING IN..." : "LOGIN SECURELY"}
                </button>
                {loginError && <p className="secure-login-error" role="alert">{loginError}</p>}
                <small>Values go only to the trusted browser worker and are discarded after use.</small>
              </form>
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
              PRIVATE WORKER · SECURE SESSION
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
                    : "Message KINO..."
              }
              disabled={isBusy}
              autoComplete="off"
            />

            <button
              type="submit"
              disabled={
                isBusy || !input.trim()
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
            Give KINO any public website URL.
            It observes visible controls and acts
            through a private browser worker.
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
