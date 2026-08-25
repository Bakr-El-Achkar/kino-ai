function compact(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

const NAVIGATION_PREFIX =
  /^(?:(?:please|can you|could you|would you)\s+)*(?:open|show|go\s+to|navigate\s+to|take\s+me\s+to)\s+(?:(?:the|my)\s+)?/i;
const NAVIGATION_SUFFIX = /\s+(?:section|page|screen|area|module)$/i;

export function normalizeNavigationTarget(value: string) {
  let normalized = compact(value);
  normalized = normalized.replace(NAVIGATION_PREFIX, "");
  normalized = normalized.replace(NAVIGATION_SUFFIX, "");
  return compact(normalized.replace(/^(?:the|my)\s+/i, ""));
}

export function navigationSemanticKey(value: string) {
  return normalizeNavigationTarget(value)
    .toLowerCase()
    .split(" ")
    .map((word) =>
      word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word)
        ? word.slice(0, -1)
        : word,
    )
    .join(" ");
}
