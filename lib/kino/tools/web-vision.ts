import { captureBrowserScreenshot } from "@/lib/kino/browser-worker/client";
import { inspectBrowserScreenshot } from "@/lib/kino/ollama/vision";

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

export type WebVisionObserveArgs = {
  goal: string;
};

export type WebVisionContext = {
  conversationId: string;
};

export async function webVisionObserve(
  args: WebVisionObserveArgs,
  context: WebVisionContext,
) {
  const goal = args.goal.trim();

  if (!goal || goal.length > 1_200) {
    return {
      success: false,
      status: "INVALID_REQUEST",
      message: "A concise visual inspection goal is required.",
    };
  }

  const screenshot = await captureBrowserScreenshot(
    context.conversationId,
  );

  if (!screenshot.success || !("bytes" in screenshot)) {
    return {
      success: false,
      status:
        typeof screenshot.status === "string"
          ? screenshot.status
          : "VISION_SCREENSHOT_FAILED",
      message:
        typeof screenshot.message === "string"
          ? screenshot.message
          : "The current browser viewport could not be captured.",
    };
  }

  const bytes = screenshot.bytes;

  if (!(bytes instanceof ArrayBuffer) || bytes.byteLength < 4) {
    return {
      success: false,
      status: "VISION_SCREENSHOT_FAILED",
      message:
        "The browser screenshot was not available in a valid format.",
    };
  }

  if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    return {
      success: false,
      status: "VISION_SCREENSHOT_TOO_LARGE",
      message:
        "The browser screenshot is too large for visual inspection.",
    };
  }

  const base64Image = Buffer.from(bytes).toString("base64");

  try {
    const observation = await inspectBrowserScreenshot({
      goal,
      imageBase64: base64Image,
      contentType: "image/jpeg",
    });

    return {
      success: true,
      status: "VISION_OBSERVED",
      message:
        "The current browser viewport was visually inspected.",
      observation: {
        source: "masked-browser-screenshot",
        trustedForActions: false,
        requiresSemanticIdsForActions: true,
        description: observation,
      },
    };
  } catch {
    return {
      success: false,
      status: "VISION_MODEL_FAILED",
      message:
        "Visual inspection is temporarily unavailable.",
    };
  }
}