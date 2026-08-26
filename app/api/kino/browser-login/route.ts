import { loginBrowser } from "@/lib/kino/browser-worker/client";
import { isValidConversationId } from "@/lib/kino/tools";

export const runtime = "nodejs";

function json(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ success: false, status: "INVALID_REQUEST" }, 403);
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const conversationId = payload.conversationId;
    let username = payload.username;
    let password = payload.password;
    delete payload.username;
    delete payload.password;
    if (
      !isValidConversationId(conversationId) || typeof username !== "string" ||
      typeof password !== "string" || !username || !password ||
      username.length > 1_000 || password.length > 4_096
    ) {
      username = "";
      password = "";
      return json({ success: false, status: "INVALID_REQUEST", message: "Secure login values are invalid." }, 400);
    }
    try {
      const result = await loginBrowser(conversationId, { username, password });
      return json(result, result.success ? 200 : 409);
    } finally {
      username = "";
      password = "";
    }
  } catch {
    return json({ success: false, status: "INVALID_REQUEST", message: "The secure login request was invalid." }, 400);
  }
}
