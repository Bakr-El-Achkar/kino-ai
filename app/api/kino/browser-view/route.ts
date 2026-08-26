import { captureBrowserScreenshot } from "@/lib/kino/browser-worker/client";
import { isValidConversationId } from "@/lib/kino/tools";

export const runtime = "nodejs";

const RESPONSE_HEADERS = {
  "Cache-Control": "no-store, private",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: RESPONSE_HEADERS });
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
    if (!isValidConversationId(conversationId)) {
      return json({ success: false, status: "INVALID_REQUEST", message: "The browser-view request is invalid." }, 400);
    }
    const result = await captureBrowserScreenshot(conversationId);
    if (!result.success) {
      return json(result, result.status === "WORKER_UNAVAILABLE" ? 503 : result.status === "SESSION_EXPIRED" ? 409 : 502);
    }
    return new Response(result.bytes, {
      status: 200,
      headers: { ...RESPONSE_HEADERS, "Content-Type": result.contentType },
    });
  } catch {
    return json({ success: false, status: "INVALID_REQUEST", message: "The browser-view request is invalid." }, 400);
  }
}
