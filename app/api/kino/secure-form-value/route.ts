import { isValidConversationId } from "@/lib/kino/tools";
import {
  cancelSensitiveFormFill,
  captureSensitiveFormValue,
} from "@/lib/kino/web-agent";
import {
  getSensitiveFormFillRequest,
  getSensitiveFormFillRuntimeSummary,
} from "@/lib/kino/web-agent/ephemeral-secrets";

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

export async function GET(request: Request) {
  if (!sameOrigin(request)) return json({ error: "ORIGIN_REJECTED" }, 403);
  const conversationId = new URL(request.url).searchParams.get("conversationId");
  if (!isValidConversationId(conversationId)) {
    return json({ error: "INVALID_CONVERSATION" }, 400);
  }
  const state = getSensitiveFormFillRuntimeSummary(conversationId);
  if (!state.exists) return json({ exists: false });
  return json({
    exists: true,
    secureRequestId: state.secureRequestId,
    stage: state.stage,
    fieldName: state.fieldName,
    expiresInSeconds: state.expiresInSeconds,
    filled: state.filled,
    verified: state.verified,
  });
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ error: "ORIGIN_REJECTED" }, 403);
  try {
    // This body is deliberately never logged or forwarded to the model route.
    const body = (await request.json()) as Record<string, unknown>;
    const conversationId = body.conversationId;
    const secureRequestId = body.secureRequestId;
    let value = body.value;
    if (
      !isValidConversationId(conversationId) ||
      typeof secureRequestId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(secureRequestId) ||
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > 4_096
    ) {
      return json({ success: false, status: "INVALID_SECURE_VALUE_REQUEST" }, 400);
    }
    delete body.value;
    let result;
    try {
      result = await captureSensitiveFormValue({
        conversationId,
        secureRequestId,
        value,
      });
    } finally {
      // Best effort only: JavaScript strings cannot be cryptographically zeroized.
      value = "";
    }
    if (!result.success) {
      return json({
        success: false,
        status: result.status,
        message: result.message,
      }, 409);
    }
    return json({
      success: true,
      status: result.status,
      fieldName: result.fieldName,
      expiresInSeconds: result.expiresInSeconds,
      browserMutation: false,
      submitted: false,
    });
  } catch {
    return json({ success: false, status: "INVALID_SECURE_VALUE_REQUEST" }, 400);
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return json({ error: "ORIGIN_REJECTED" }, 403);
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (
      !isValidConversationId(body.conversationId) ||
      typeof body.secureRequestId !== "string"
    ) {
      return json({ success: false, status: "INVALID_SECURE_VALUE_REQUEST" }, 400);
    }
    const lookup = getSensitiveFormFillRequest(
      body.conversationId,
      body.secureRequestId,
    );
    if (lookup.status !== "FOUND") return json({ success: false, status: lookup.status }, 409);
    const result = cancelSensitiveFormFill({
      context: {
        requestedAt: new Date(),
        conversationId: body.conversationId,
        latestUserMessage: "Cancel",
        source: "chat",
      },
    });
    return result.status === "SENSITIVE_FILL_CANCELLED"
      ? json({ success: true, status: result.status, browserMutation: false })
      : json({ success: false, status: result.status }, 409);
  } catch {
    return json({ success: false, status: "INVALID_SECURE_VALUE_REQUEST" }, 400);
  }
}
