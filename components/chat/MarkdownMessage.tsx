"use client";

import { Children, isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { normalizeMarkdown } from "./normalize-markdown";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return <button type="button" className="chat-copy" aria-label={label} onClick={async () => {
    try { await navigator.clipboard.writeText(text); setStatus("Copied"); }
    catch { setStatus("Copy failed"); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus(""), 2000);
  }}><span aria-live="polite">{status || label}</span></button>;
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children)[0];
  const props = isValidElement<{ className?: string; children?: string }>(child) ? child.props : null;
  const language = props?.className?.replace(/^language-/, "");
  return <div className="chat-code-block">
    <div className="chat-code-header"><span>{language || "Code"}</span><CopyButton text={String(props?.children ?? "")} label="Copy code" /></div>
    <pre>{children}</pre>
  </div>;
}

export function MarkdownMessage({ content }: { content: string }) {
  return <div className="chat-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    pre: CodeBlock,
    a: ({ children, href }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    table: ({ children }) => <div className="chat-table-scroll" tabIndex={0} role="region" aria-label="Response table"><table>{children}</table></div>,
  }}>{normalizeMarkdown(content)}</ReactMarkdown></div>;
}
