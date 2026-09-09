export const ACTIVITY_KINDS = ["reasoning", "browser", "reading", "tool", "verification", "confirmation", "response"] as const;
export type ActivityKind = typeof ACTIVITY_KINDS[number];
export type Activity = { label: string; kind: ActivityKind };

// Display-only, conservative hostname filter. Never copies paths, ports, userinfo or values.
// Exclude all IP literals and local/reserved hostnames; DNS authorization stays with the worker.
export function activityHostname(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return;
    if (host.length > 120 || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}$/.test(host)) return;
    if (/(?:^|\.)(?:localhost|local|internal|lan|home|corp|test|invalid|onion)$|\.home\.arpa$/.test(host)) return;
    return host;
  } catch { return; }
}

export const reasoningActivity = (thinking: boolean): Activity => ({ kind: "reasoning", label: thinking ? "Reasoning deeply..." : "Working..." });
export const responseActivity: Activity = { kind: "response", label: "Preparing response..." };
export const confirmationActivity: Activity = { kind: "confirmation", label: "Waiting for confirmation..." };
export const verificationActivity: Activity = { kind: "verification", label: "Verifying result..." };

export function toolActivity(name: string, args: Record<string, unknown>, pageUrl?: unknown, repeatedRead = false): Activity {
  const host = activityHostname(name === "web_open_url" ? args.url : pageUrl);
  const at = (verb: string, fallback: string) => host ? `${verb} ${host}` : fallback;
  if (name === "web_open_url") return { kind: "browser", label: at("Opening", "Opening page...") };
  if (name === "web_observe") return { kind: "reading", label: repeatedRead ? "Inspecting results..." : at("Reading", "Reading page...") };
  if (name === "web_confirm_pending_action") return verificationActivity;
  if (name === "web_cancel_pending_action") return { kind: "confirmation", label: "Cancelling pending action..." };
  if (name === "web_close_session") return { kind: "browser", label: "Closing browser..." };
  if (name === "web_action") {
    if (args.action === "back" || args.action === "reload") return { kind: "browser", label: at("Navigating", "Navigating page...") };
    if (args.action === "scroll") return { kind: "reading", label: at("Reading", "Reading page...") };
    if (["fill", "select", "check", "uncheck"].includes(String(args.action))) return { kind: "browser", label: "Updating page control..." };
    return { kind: "browser", label: "Interacting with page..." };
  }
  return { kind: "tool", label: "Running tool..." };
}

// Client accepts only our label vocabulary, never arbitrary strings or extra event fields.
export function parseActivity(value: Record<string, unknown>): Activity | null {
  if (!(ACTIVITY_KINDS as readonly unknown[]).includes(value.kind) || typeof value.label !== "string") return null;
  const fixed: Record<ActivityKind, string[]> = {
    reasoning: ["Reasoning deeply...", "Working..."],
    browser: ["Opening page...", "Navigating page...", "Interacting with page...", "Updating page control...", "Closing browser..."],
    reading: ["Reading page...", "Inspecting results..."],
    tool: ["Running tool..."], verification: ["Verifying result..."],
    confirmation: ["Waiting for confirmation...", "Cancelling pending action..."], response: ["Preparing response..."],
  };
  const kind = value.kind as ActivityKind;
  if (fixed[kind].includes(value.label)) return { kind, label: value.label };
  const match = /^(Opening|Navigating|Reading) ([a-z0-9.-]+)$/.exec(value.label);
  if (match && kind === (match[1] === "Reading" ? "reading" : "browser") && activityHostname(`https://${match[2]}`) === match[2]) return { kind, label: value.label };
  return null;
}
