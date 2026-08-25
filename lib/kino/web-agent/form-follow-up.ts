export function looksLikeFormDraftValueFollowUp(message: string) {
  const trimmed = message.trim();
  if (!trimmed || trimmed.length > 1_000 || trimmed.includes("?")) return false;
  if (/^(?:what|why|when|where|who|how|is|are|can|could|should|would|do|does)\b/i.test(trimmed)) {
    return false;
  }
  if (/^[+()\d\s.-]{7,30}$/.test(trimmed)) return true;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return true;
  return /^[\p{L}][\p{L}\p{N}\s_.-]{0,100}\s+(?:is|=)\s+\S.+$/u.test(trimmed);
}

export function parseNamedFormDraftValue(message: string) {
  const trimmed = message.trim();
  if (!looksLikeFormDraftValueFollowUp(trimmed)) return null;
  const match = trimmed.match(
    /^(?:(?:the|his|her|my|their)\s+)?([\p{L}][\p{L}\p{N}\s_.-]{0,100}?)\s+(?:is|=)\s+(.+)$/iu,
  );
  if (!match) return null;
  return { field: match[1].trim(), value: match[2].trim() };
}
