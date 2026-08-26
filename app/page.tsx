"use client";

import Image from "next/image";
import {
  FormEvent,
  useCallback,
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

type BrowserView = {
  active: boolean;
  status: string;
  url?: string;
  title?: string;
  pageStatus?: string;
  authentication?: LoginChallenge;
  updatedAt?: string;
};

type BrowserPreviewState = "idle" | "starting" | "live" | "updating" | "stale" | "offline";

function createId() {
  return `${Date.now()}-${Math.random()}`;
}

function browserHostname(url?: string) {
  if (!url) return "Awaiting page";
  try {
    return new URL(url).hostname;
  } catch {
    return "KINO Browser";
  }
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

  const [browserView, setBrowserView] = useState<BrowserView>({ active: false, status: "SESSION_EXPIRED" });
  const [browserPreviewUrl, setBrowserPreviewUrl] = useState<string | null>(null);
  const [browserPreviewState, setBrowserPreviewState] = useState<BrowserPreviewState>("idle");
  const [browserIntent, setBrowserIntent] = useState(false);
  const [browserCollapsed, setBrowserCollapsed] = useState(false);

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

  const browserActiveRef = useRef(false);
  const browserIntentRef = useRef(false);
  const screenshotObjectUrlRef = useRef<string | null>(null);
  const screenshotRequestRef = useRef(false);

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

  const refreshBrowserState = useCallback(async (signal?: AbortSignal) => {
    const conversationId = conversationIdRef.current;
    if (!conversationId) return false;
    try {
      const response = await fetch("/api/kino/browser-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
        cache: "no-store",
        signal,
      });
      const state = await response.json() as BrowserView;
      if (state.active) {
        browserActiveRef.current = true;
        browserIntentRef.current = false;
        setBrowserView(state);
        setBrowserIntent(false);
        if (state.pageStatus === "AUTH_REQUIRED") {
          setLoginChallenge(state.authentication ?? {});
        } else {
          setLoginChallenge(null);
        }
        return true;
      }
      if (state.status === "SESSION_EXPIRED") {
        if (browserIntentRef.current) return false;
        browserActiveRef.current = false;
        setBrowserView({ active: false, status: state.status });
        setBrowserIntent(false);
        setBrowserPreviewState("idle");
        setLoginChallenge(null);
        const previous = screenshotObjectUrlRef.current;
        screenshotObjectUrlRef.current = null;
        setBrowserPreviewUrl(null);
        if (previous) URL.revokeObjectURL(previous);
      } else if (state.status === "WORKER_UNAVAILABLE" && browserActiveRef.current) {
        setBrowserPreviewState(screenshotObjectUrlRef.current ? "stale" : "offline");
      }
      return false;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") return browserActiveRef.current;
      if (browserActiveRef.current) {
        setBrowserPreviewState(screenshotObjectUrlRef.current ? "stale" : "offline");
      }
      return browserActiveRef.current;
    }
  }, []);

  const refreshBrowserScreenshot = useCallback(async (signal?: AbortSignal) => {
    const conversationId = conversationIdRef.current;
    if (!conversationId || screenshotRequestRef.current) return;
    screenshotRequestRef.current = true;
    if (screenshotObjectUrlRef.current) setBrowserPreviewState("updating");
    try {
      const response = await fetch("/api/kino/browser-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
        cache: "no-store",
        signal,
      });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { status?: string } | null;
        if (result?.status === "SESSION_EXPIRED") {
          browserActiveRef.current = false;
          browserIntentRef.current = false;
          setBrowserView({ active: false, status: "SESSION_EXPIRED" });
          setBrowserIntent(false);
          setBrowserPreviewState("idle");
          const previous = screenshotObjectUrlRef.current;
          screenshotObjectUrlRef.current = null;
          setBrowserPreviewUrl(null);
          if (previous) URL.revokeObjectURL(previous);
        } else {
          setBrowserPreviewState(screenshotObjectUrlRef.current ? "stale" : "offline");
        }
        return;
      }
      const blob = await response.blob();
      if (blob.type !== "image/jpeg") throw new Error("INVALID_SCREENSHOT");
      const nextUrl = URL.createObjectURL(blob);
      const previous = screenshotObjectUrlRef.current;
      screenshotObjectUrlRef.current = nextUrl;
      setBrowserPreviewUrl(nextUrl);
      setBrowserPreviewState("live");
      if (previous) URL.revokeObjectURL(previous);
    } catch (error) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        setBrowserPreviewState(screenshotObjectUrlRef.current ? "stale" : "offline");
      }
    } finally {
      screenshotRequestRef.current = false;
    }
  }, []);

  useEffect(() => {
    return () => {
      const current = screenshotObjectUrlRef.current;
      if (current) URL.revokeObjectURL(current);
    };
  }, []);

  useEffect(() => {
    if (!conversationIdRef.current || (!browserIntent && !browserView.active)) return;
    let stopped = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const schedule = () => {
      if (!stopped) timer = setTimeout(tick, 1_800);
    };
    const tick = async () => {
      if (stopped || running) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }
      running = true;
      controller = new AbortController();
      const active = await refreshBrowserState(controller.signal);
      if (active && !browserCollapsed && !stopped) await refreshBrowserScreenshot(controller.signal);
      running = false;
      schedule();
    };
    const visibilityChanged = () => {
      if (document.visibilityState === "visible" && !running) {
        if (timer) clearTimeout(timer);
        void tick();
      }
    };
    void tick();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [browserCollapsed, browserIntent, browserView.active, refreshBrowserScreenshot, refreshBrowserState]);

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

      if (/https?:\/\/|\b(?:open|visit|browse|navigate|go\s+to)\b/i.test(command)) {
        browserIntentRef.current = true;
        setBrowserIntent(true);
        if (!browserActiveRef.current) setBrowserPreviewState("starting");
      }

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

      if (browserActiveRef.current && !browserCollapsed) {
        await refreshBrowserScreenshot();
      } else if (!browserActiveRef.current && browserIntentRef.current) {
        browserIntentRef.current = false;
        setBrowserIntent(false);
        setBrowserPreviewState("idle");
      }

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
        await refreshBrowserState();
        if (browserActiveRef.current && !browserCollapsed) await refreshBrowserScreenshot();
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

  const showBrowserPanel = browserIntent || browserView.active;
  const browserStatusLabel = browserPreviewState === "stale"
    ? "STALE"
    : browserPreviewState === "offline"
      ? "OFFLINE"
      : browserPreviewState === "starting"
        ? "STARTING"
        : browserPreviewState === "updating"
          ? "SYNCING"
          : "LIVE";

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

      <div className={`kino-workspace-shell ${showBrowserPanel ? "has-live-browser" : ""} ${browserCollapsed ? "browser-is-collapsed" : ""}`}>
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

      {showBrowserPanel && (
        <aside className={`live-browser-panel ${browserCollapsed ? "live-browser-panel-collapsed" : ""}`} aria-label="KINO Live Browser">
          <div className="live-browser-header">
            <div className="live-browser-identity">
              <span className={`live-browser-dot live-browser-dot-${browserPreviewState}`} />
              <div>
                <span className="live-browser-kicker">{browserStatusLabel} BROWSER</span>
                <strong>KINO LIVE VIEW</strong>
              </div>
            </div>
            <div className="live-browser-controls">
              {!browserCollapsed && (
                <button
                  type="button"
                  onClick={() => void refreshBrowserScreenshot()}
                  disabled={browserPreviewState === "updating"}
                  aria-label="Refresh KINO Browser preview"
                >
                  ↻
                </button>
              )}
              <button
                type="button"
                onClick={() => setBrowserCollapsed((current) => !current)}
                aria-label={browserCollapsed ? "Expand KINO Browser" : "Collapse KINO Browser"}
              >
                {browserCollapsed ? "＋" : "−"}
              </button>
            </div>
          </div>

          {!browserCollapsed && (
            <>
              <div className="live-browser-page-meta">
                <div>
                  <strong>{browserView.title || "Initializing secure viewport"}</strong>
                  <span>{browserHostname(browserView.url)}</span>
                </div>
                {browserView.pageStatus && browserView.pageStatus !== "OBSERVED" && (
                  <span className="live-browser-page-status">{browserView.pageStatus.replaceAll("_", " ")}</span>
                )}
              </div>

              <div className={`live-browser-viewport live-browser-viewport-${browserPreviewState}`} aria-live="polite">
                {browserPreviewUrl ? (
                  <Image
                    src={browserPreviewUrl}
                    alt={`Current KINO Browser viewport: ${browserView.title || "website"}`}
                    fill
                    sizes="(max-width: 900px) 100vw, 46vw"
                    unoptimized
                    draggable={false}
                  />
                ) : browserPreviewState === "offline" ? (
                  <div className="live-browser-empty-state">
                    <span className="live-browser-offline-mark">!</span>
                    <strong>KINO Browser temporarily unavailable</strong>
                    <small>Chat remains online. The preview will reconnect automatically.</small>
                  </div>
                ) : (
                  <div className="live-browser-empty-state live-browser-starting">
                    <span className="live-browser-scan" />
                    <strong>Initializing isolated viewport</strong>
                    <small>KINO is connecting to the controlled browser session.</small>
                  </div>
                )}
                {browserPreviewUrl && browserPreviewState === "updating" && <span className="live-browser-sync-line" />}
                {browserPreviewUrl && browserPreviewState === "stale" && (
                  <span className="live-browser-stale-note">Preview connection interrupted · showing last frame</span>
                )}
              </div>

              <div className="live-browser-location" title={browserView.url || ""}>
                <span>SECURE VIEW</span>
                <p>{browserView.url || "Waiting for KINO Browser…"}</p>
              </div>
            </>
          )}
        </aside>
      )}
      </div>

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
