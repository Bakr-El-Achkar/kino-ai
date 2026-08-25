import type { WebFormField } from "./form-types";

export function normalizeFormFieldName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/e[\s-]?mail/g, "email")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function semanticTokens(value: string) {
  const tokens = normalizeFormFieldName(value)
    .replace(/\bfull\s*name\b/g, "name")
    .split(" ")
    .filter(Boolean)
    .map((token) => {
      if (["telephone", "mobile", "cellphone"].includes(token)) return "phone";
      return token;
    })
    .filter((token) => !["field", "input", "value", "the", "your"].includes(token));
  if (tokens.includes("email")) return tokens.filter((token) => token !== "address");
  if (tokens.includes("phone")) return tokens.filter((token) => token !== "number");
  if (tokens.includes("name")) return tokens.filter((token) => token !== "full");
  return tokens;
}

function semanticKey(value: string) {
  return Array.from(new Set(semanticTokens(value))).sort().join(" ");
}

function overlapScore(requested: string, candidate: string) {
  const requestedTokens = new Set(semanticTokens(requested));
  const candidateTokens = new Set(semanticTokens(candidate));
  if (requestedTokens.size === 0 || candidateTokens.size === 0) return 0;
  const intersection = [...requestedTokens].filter((token) => candidateTokens.has(token));
  if (intersection.length === 0) return 0;
  const coverage = intersection.length / requestedTokens.size;
  const similarity = intersection.length / new Set([...requestedTokens, ...candidateTokens]).size;
  return coverage === 1 ? 50 + similarity * 20 : similarity >= 0.75 ? 40 + similarity * 10 : 0;
}

function scoreField(requested: string, field: WebFormField) {
  const normalizedRequest = normalizeFormFieldName(requested);
  const normalizedName = normalizeFormFieldName(field.name);
  if (normalizedRequest === normalizedName) return 100;
  if (semanticKey(requested) === semanticKey(field.name)) return 90;
  if (
    normalizedName.startsWith(`${normalizedRequest} `) ||
    normalizedRequest.startsWith(`${normalizedName} `)
  ) {
    return 75;
  }
  if (
    normalizedName.includes(normalizedRequest) ||
    normalizedRequest.includes(normalizedName)
  ) {
    return 65;
  }
  return overlapScore(requested, field.name);
}

export type FormFieldMatch =
  | { status: "MATCHED"; field: WebFormField }
  | { status: "FIELD_NOT_FOUND" }
  | { status: "FIELD_AMBIGUOUS"; candidates: string[] };

export function matchFormField(
  requestedField: string,
  fields: WebFormField[],
): FormFieldMatch {
  const ranked = fields
    .map((field) => ({ field, score: scoreField(requestedField, field) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score);
  if (ranked.length === 0) return { status: "FIELD_NOT_FOUND" };
  const best = ranked[0].score;
  const matches = ranked.filter(({ score }) => score === best);
  if (matches.length !== 1) {
    return {
      status: "FIELD_AMBIGUOUS",
      candidates: Array.from(new Set(matches.map(({ field }) => field.name))),
    };
  }
  return { status: "MATCHED", field: matches[0].field };
}

const SENSITIVE_FIELD_PATTERNS = [
  /\bpassword\b/,
  /\bpasscode\b/,
  /\bpin\b/,
  /\b(?:credit|debit|payment)\s+card\b/,
  /\bcard\s+number\b/,
  /\b(?:cvv|cvc)\b/,
  /\b(?:bank|financial)\s+account\b/,
  /\b(?:routing|swift)\s+(?:number|code)\b/,
  /\biban\b/,
  /\b(?:government|national|tax)\s+id\b/,
  /\b(?:ssn|passport)\b/,
  /\b(?:authentication|auth|access)\s+token\b/,
  /\bapi\s+key\b/,
  /\bclient\s+secret\b/,
  /\bsecret\s+key\b/,
  /\bprivate\s+key\b/,
];

export function isSensitiveFormField(field: Pick<WebFormField, "name">) {
  const normalized = normalizeFormFieldName(field.name);
  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(normalized));
}
