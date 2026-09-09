// Display-only repair. Never rewrite code, paths, or isolated literal escapes.
export function normalizeMarkdown(content: string) {
  let fence: string | null = null;
  return content.split("\n").map((line) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return line;
    }
    if (fence || /^( {4}|\t)/.test(line)) return line;
    return line.split(/(`+[^`]*`+)/g).map((part, index) => {
      if (index % 2) return part;
      return part
        .replace(/(?<!\\)\\\*\\\*([^*\n]+?)\\\*\\\*/g, "**$1**")
        .replace(/^( {0,3})(?:\\#){1,6}(?=\s)/, (match) => match.replaceAll("\\", ""))
        .replace(/^( {0,3})\\-(?=\s+\S)/, "$1-");
    }).join("");
  }).join("\n");
}
