const BROWSER_GOAL = /\b(?:open|visit|browse|navigate|click|find|go\s+(?:to|back)|return\s+to|website|page)\b/i;
const SAFE_NEXT_STEP_NARRATION = /\b(?:let me|i(?:'ll| will| can now)|next(?:,|\s+i)|now\s+i\s+(?:can|will)|going to)\b[\s\S]{0,180}\b(?:click|open|navigate|visit|go\s+back|return|select|observe)\b/i;

export function shouldContinueSafeBrowserNarration(userRequest: string, assistantContent: string, continuationCount: number) {
  return continuationCount < 2 && BROWSER_GOAL.test(userRequest) && SAFE_NEXT_STEP_NARRATION.test(assistantContent);
}
