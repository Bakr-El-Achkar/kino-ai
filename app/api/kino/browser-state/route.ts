import { observeBrowser } from "@/lib/kino/browser-worker/client";
import { isValidConversationId } from "@/lib/kino/tools";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!isValidConversationId(conversationId)) {
    return Response.json({ success: false, status: "INVALID_REQUEST" }, { status: 400 });
  }
  const result = await observeBrowser(conversationId);
  const responseBody = "observation" in result && result.observation
    ? {
        success: result.success,
        status: result.status,
        observation: {
          status: result.observation.status,
          authentication: result.observation.authentication,
        },
      }
    : result;
  return Response.json(responseBody, {
    status: result.status === "WORKER_UNAVAILABLE" ? 503 : 200,
    headers: { "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff" },
  });
}
