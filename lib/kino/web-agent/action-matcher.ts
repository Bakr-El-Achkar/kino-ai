import type { ActionMatchResult, WebActionCandidate } from "./action-types";

const IGNORED_TOKENS = new Set([
  "a",
  "an",
  "the",
  "please",
  "can",
  "could",
  "would",
  "you",
  "me",
  "this",
  "that",
]);

const MAX_SAFE_CANDIDATE_NAMES = 12;

export function normalizeActionText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function meaningfulTokens(value: string) {
  return normalizeActionText(value)
    .split(" ")
    .filter((token) => token && !IGNORED_TOKENS.has(token));
}

function rankAction(candidateName: string, intent: string) {
  const candidate = normalizeActionText(candidateName);
  const requested = normalizeActionText(intent);
  if (!candidate || !requested) return null;
  if (candidate === requested) return 1;

  const candidateTokens = meaningfulTokens(candidate);
  const requestedTokens = meaningfulTokens(requested);
  if (
    candidateTokens.length > 0 &&
    candidateTokens.length === requestedTokens.length &&
    candidateTokens.every((token, index) => token === requestedTokens[index])
  ) {
    return 2;
  }

  const candidateMeaning = candidateTokens.join(" ");
  const requestedMeaning = requestedTokens.join(" ");
  if (!candidateMeaning || !requestedMeaning) return null;
  if (candidateMeaning.startsWith(requestedMeaning)) return 3;
  if (requestedMeaning.startsWith(candidateMeaning)) return 3;
  if (candidateMeaning.includes(requestedMeaning)) return 4;
  if (requestedMeaning.includes(candidateMeaning)) return 4;

  const candidateSet = new Set(candidateTokens);
  const overlap = requestedTokens.filter((token) => candidateSet.has(token)).length;
  const smallerSize = Math.min(candidateTokens.length, requestedTokens.length);
  if (overlap >= 2 && overlap === smallerSize) return 5;
  return null;
}

function safeCandidateNames(candidates: WebActionCandidate[]) {
  return [...new Set(candidates.map(({ name }) => name))].slice(
    0,
    MAX_SAFE_CANDIDATE_NAMES,
  );
}

export function matchWebAction(
  intent: string,
  candidates: WebActionCandidate[],
): ActionMatchResult {
  const ranked = candidates
    .map((candidate) => ({ candidate, rank: rankAction(candidate.name, intent) }))
    .filter(
      (item): item is { candidate: WebActionCandidate; rank: number } =>
        item.rank !== null,
    );

  if (ranked.length === 0) {
    return { status: "NO_ACTION_MATCH", candidates: safeCandidateNames(candidates) };
  }

  const bestRank = Math.min(...ranked.map(({ rank }) => rank));
  const best = ranked
    .filter(({ rank }) => rank === bestRank)
    .map(({ candidate }) => candidate);

  if (best.length !== 1) {
    return { status: "AMBIGUOUS_ACTION", candidates: safeCandidateNames(best) };
  }

  return { status: "MATCHED", candidate: best[0] };
}
