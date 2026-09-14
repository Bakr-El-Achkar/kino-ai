export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
export const DEFAULT_IMAGE_PROMPT = "Analyze this image.";

export function imageFileError(file: { type: string; size: number }) {
  if (!(IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) return "Choose a JPEG, PNG, or WEBP image.";
  if (file.size > MAX_IMAGE_BYTES) return "Image must be 3 MiB or smaller.";
  if (file.size === 0) return "Choose a non-empty image.";
  return null;
}
