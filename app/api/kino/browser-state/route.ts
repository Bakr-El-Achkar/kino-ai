import { getBrowserViewState } from "@/lib/kino/browser-worker/client";
import { isValidConversationId } from "@/lib/kino/tools";

export const runtime = "nodejs";

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ success: false, status: "INVALID_REQUEST" }, { status: 403 });
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const conversationId = payload.conversationId;
    if (!isValidConversationId(conversationId)) {
      return Response.json({ success: false, status: "INVALID_REQUEST", active: false }, { status: 400 });
    }
    const result = await getBrowserViewState(conversationId);
    return Response.json(result, {
      status: result.status === "WORKER_UNAVAILABLE" ? 503 : result.status === "SESSION_EXPIRED" ? 409 : 200,
      headers: {
        "Cache-Control": "no-store, private",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json({ success: false, status: "INVALID_REQUEST", active: false }, { status: 400 });
  }
}
