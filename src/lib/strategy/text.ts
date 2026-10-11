/**
 * Deterministic text analysis used to check (never trust) parser output:
 * number normalisation for grounding, and safety scans on the raw text.
 */

export interface TextNumber {
  value: number;
  raw: string;
  percent: boolean;
  dollar: boolean;
}

/**
 * Extracts numbers as a person would read them:
 * "$100k" → 100000, "1.5m" → 1500000, "100,000" → 100000, "2%" → 2.
 */
export function extractNumbers(text: string): TextNumber[] {
  const out: TextNumber[] = [];
  const re = /(\$\s*)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|m|bn|b|thousand|million|billion)?\b\s*(%|percent|pct)?/gi;
  for (const m of text.matchAll(re)) {
    const base = Number(`${m[2]!.replace(/,/g, "")}${m[3] ? `.${m[3]}` : ""}`);
    const unit = (m[4] ?? "").toLowerCase();
    const mult = unit === "k" || unit === "thousand" ? 1e3 : unit === "m" || unit === "million" ? 1e6 : unit === "b" || unit === "bn" || unit === "billion" ? 1e9 : 1;
    out.push({ value: base * mult, raw: m[0].trim(), percent: !!m[5], dollar: !!m[1] || /\b(usd|dollars?)\b/i.test(text.slice(m.index! + m[0].length, m.index! + m[0].length + 9)) });
  }
  return out;
}

/** True if `value` (or its magnitude) is a number the user actually wrote. */
export function isGrounded(value: number, text: string): boolean {
  const target = Math.abs(value);
  return extractNumbers(text).some((n) => Math.abs(n.value - target) <= Math.max(1e-9, target * 1e-9));
}

export interface SafetyFinding {
  code: "LEVERAGE_OR_DERIVATIVES" | "UNSUPPORTED_ACTION" | "UNSAFE_PARAMETER" | "AMBIGUOUS_TRADE_SIZE" | "CONFLICTING_INSTRUCTIONS";
  message: string;
  match: string;
}

const SCANS: Array<{ code: SafetyFinding["code"]; re: RegExp; message: string }> = [
  // Leverage, perpetuals, derivatives, shorting
  { code: "LEVERAGE_OR_DERIVATIVES", re: /\b\d+(?:\.\d+)?\s*x\b(?!\s*(?:per|a)\b)|\blever(?:age|aged|aging)?\b|\bmargin\b|\bperp(?:s|etual|etuals)?\b|\bfutures?\b|\boptions?\b|\bcall options?\b|\bput options?\b|\bderivatives?\b/i, message: "Leverage, perpetuals, futures and options aren't supported. GapPilot is spot only." },
  { code: "LEVERAGE_OR_DERIVATIVES", re: /\bshort(?:ing|s|ed)?\b(?!\s*(?:term|while))|\bborrow(?:ing|ed)?\b/i, message: "Short selling and borrowing aren't possible with spot trading. A SELL rule can only sell tokens you already hold." },
  // Actions other than spot buy/sell
  { code: "UNSUPPORTED_ACTION", re: /\b(?:bridge|stake|staking|lend|lending|farm|yield farm\w*|provide liquidity|add liquidity|withdraw|transfer|airdrop|mint|redeem)\b|\bsend\s+(?:funds|tokens|money|usdt|it|them|to)\b/i, message: "Only BUY and SELL rules are supported." },
  // Unsafe transaction parameters
  { code: "UNSAFE_PARAMETER", re: /0x[0-9a-fA-F]{6,}/, message: "Strategies can't contain addresses or transaction data." },
  { code: "UNSAFE_PARAMETER", re: /\b(?:unlimited|infinite|max(?:imum)?)\s+(?:token\s+)?approv\w*|\bapprove\s+(?:all|everything|unlimited)\b/i, message: "Approval amounts can't be set by a strategy; approvals are sized per trade." },
  { code: "UNSAFE_PARAMETER", re: /\b(?:gas\s*(?:price|limit)|calldata|nonce|private key|seed phrase|mnemonic|recipient|receiver)\b/i, message: "Strategies can't set transaction parameters or reference keys." },
  { code: "UNSAFE_PARAMETER", re: /\b(?:skip|without|no|disable|bypass|ignore)\s+(?:the\s+|any\s+)?simulat\w*/i, message: "Simulation is always required and can't be turned off." },
  { code: "UNSAFE_PARAMETER", re: /\b(?:auto(?:matically)?[- ]?(?:execute|trade|buy|sell)|execute\s+(?:immediately|instantly|automatically)|without\s+(?:asking|confirm\w*|approval|my approval))\b/i, message: "Automatic execution isn't available. Every trade will need your confirmation." },
  // Trade size that isn't one fixed dollar amount
  { code: "AMBIGUOUS_TRADE_SIZE", re: /\d+(?:\.\d+)?\s*(?:%|percent)\s+of\s+(?:my|the|your)?\s*(?:balance|wallet|portfolio|funds|holdings|capital|position)/i, message: "Trade size must be a fixed dollar amount, not a share of your balance." },
  { code: "AMBIGUOUS_TRADE_SIZE", re: /\b(?:all|everything|entire|full|whole)\s+(?:of\s+)?(?:my|the|your)?\s*(?:balance|funds|money|wallet|capital|usdt|stablecoins?|holdings)\b|\bas much as (?:possible|i can|available)\b|\ball[- ]in\b|\bmax(?:imum)? possible\b|\bwhatever (?:i have|is available)\b/i, message: "Trade size must be a fixed dollar amount, not \"all\" or \"as much as possible\"." },
  { code: "AMBIGUOUS_TRADE_SIZE", re: /(?:\b(?:around|about|roughly|approximately|approx\.?)|~)\s*\$\s*\d[\d,.]*\s*(?:k|m)?(?=[^.]{0,25}\btrade)|\$\s*\d[\d,.]*\s*(?:k|m)?\s*(?:-|–|to|or)\s*\$?\s*\d[\d,.]*\s*(?:k|m)?\s*(?:per|a|each)?\s*trade|between\s+\$?\s*\d[\d,.]*\s*(?:k|m)?\s+and\s+\$?\s*\d/i, message: "Trade size must be one exact amount, not an approximation or a range." },
];

export function scanText(text: string): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  for (const s of SCANS) {
    const m = text.match(s.re);
    if (m && !findings.some((f) => f.message === s.message)) findings.push({ code: s.code, message: s.message, match: m[0] });
  }
  if (/\b(?:buy|purchase|accumulate)\b/i.test(text) && /\bsell\b/i.test(text)) {
    findings.push({ code: "CONFLICTING_INSTRUCTIONS", message: "The rule mentions both buying and selling. Write one rule per action.", match: "buy … sell" });
  }
  return findings;
}
