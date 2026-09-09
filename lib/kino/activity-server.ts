import { validatePublicUrl } from "../../browser-worker/url-security.ts";
import { activityHostname, toolActivity, type Activity } from "./activity.ts";

// DNS-based privacy check is display-only. Never authorizes or changes a tool request.
// A slow/failed check yields a generic label rather than delaying activity indefinitely.
export async function safeToolActivity(
  name: string,
  args: Record<string, unknown>,
  pageUrl?: unknown,
  repeatedRead = false,
  validate: typeof validatePublicUrl = validatePublicUrl,
): Promise<Activity> {
  const candidate = toolActivity(name, args, pageUrl, repeatedRead);
  const host = activityHostname(name === "web_open_url" ? args.url : pageUrl);
  if (!host || !candidate.label.endsWith(` ${host}`)) return candidate;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const allowed = await Promise.race([
      validate(`https://${host}/`).then(result => result.allowed).catch(() => false),
      new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 200); }),
    ]);
    return allowed ? candidate : toolActivity(name, { ...args, url: undefined }, undefined, repeatedRead);
  } finally { if (timer) clearTimeout(timer); }
}
