import type { AssessmentFacts } from "./facts";

/**
 * Post-generation guard. The model's text is shown ONLY if:
 *   1. every number in it matches a number present in the facts (rounding allowed),
 *   2. it contains no promissory or advice language,
 *   3. it is non-empty and short.
 * Anything else is discarded; the UI says so rather than showing it.
 */

export type ValidationResult =
  | { ok: true; numbersChecked: number }
  | { ok: false; reason: "empty" | "too_long" | "banned_language" | "unverified_number"; detail: string };

const BANNED =
  /guarantee|risk[- ]?free|riskless|no[- ]risk|zero[- ]risk|sure (?:profit|thing|bet)|free money|can(?:'|no)t lose|cannot lose|\byou should (?:buy|sell)\b|\bwill (?:profit|make money|gain|earn)\b|\block(?:ed)? in (?:a )?profit/i;

const HEX = /0x[0-9a-fA-F]+/g;
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

function stripIdentifiers(text: string, identifiers: string[]): string {
  let out = text.replace(HEX, " ");
  // Symbols/tickers can contain digits (e.g. "XYZ2"); they're names, not figures.
  for (const id of identifiers.filter((s) => /\d/.test(s)).sort((a, b) => b.length - a.length)) {
    out = out.split(id).join(" ");
  }
  return out;
}

function numbersIn(text: string): Array<{ value: number; decimals: number; raw: string }> {
  return [...text.matchAll(NUMBER)]
    .map((m) => m[0].replace(/,/g, ""))
    .filter((s) => s !== "" && !Number.isNaN(Number(s)))
    .map((s) => ({ value: Number(s), decimals: s.includes(".") ? s.split(".")[1]!.length : 0, raw: s }));
}

/** Every number appearing anywhere in `facts` (identifiers with digits excluded). */
export function allowedNumbersFrom(facts: unknown, identifiers: string[]): number[] {
  const json = stripIdentifiers(JSON.stringify(facts), identifiers);
  return [...new Set(numbersIn(json).map((n) => n.value))];
}

export function allowedNumbers(facts: AssessmentFacts): number[] {
  return allowedNumbersFrom(facts, [facts.asset.symbol, facts.asset.underlyingTicker, facts.comparedWith.source]);
}

function matches(n: { value: number; decimals: number }, allowed: number[]): boolean {
  const roundingTol = 0.5 * 10 ** -n.decimals;
  return allowed.some((a) => {
    const diff = Math.abs(n.value - Math.abs(a));
    return diff <= roundingTol + 1e-9 || diff <= Math.abs(a) * 0.005;
  });
}

export function validateAssessment(text: string, facts: AssessmentFacts): ValidationResult {
  return validateAgainstFacts(text, facts, [facts.asset.symbol, facts.asset.underlyingTicker, facts.comparedWith.source]);
}

/**
 * Generic guard: text is accepted only if every number in it appears in `facts`
 * (rounding tolerance), with no promissory/advice language.
 */
export function validateAgainstFacts(text: string, facts: unknown, identifiers: string[], maxLength = 900): ValidationResult {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: "empty", detail: "No text was returned." };
  if (trimmed.length > maxLength) return { ok: false, reason: "too_long", detail: `${trimmed.length} characters` };
  const banned = trimmed.match(BANNED);
  if (banned) return { ok: false, reason: "banned_language", detail: banned[0] };

  const found = numbersIn(stripIdentifiers(trimmed, identifiers));
  const allowed = allowedNumbersFrom(facts, identifiers);
  const bad = found.filter((n) => !matches(n, allowed));
  if (bad.length) {
    return { ok: false, reason: "unverified_number", detail: bad.map((b) => b.raw).join(", ") };
  }
  return { ok: true, numbersChecked: found.length };
}
