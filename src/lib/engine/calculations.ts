/**
 * Deterministic financial calculations for the Opportunity Engine.
 *
 * Pure functions: no I/O, no clock reads (time is passed in), no LLM.
 * Invalid inputs return null rather than a misleading number.
 */

import type { EnginePolicy, QuoteInput } from "./types";

const isPos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const isFiniteNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// ── Units ────────────────────────────────────────────────────────────────────

/** USD per share from USD per token. 1 token ≈ `tokenToShareRatio` shares. */
export function perSharePrice(tokenPriceUsd: number, tokenToShareRatio: number): number | null {
  if (!isPos(tokenPriceUsd) || !isPos(tokenToShareRatio)) return null;
  return tokenPriceUsd / tokenToShareRatio;
}

/** Smallest-unit integer string → decimal number. Exact integer split via BigInt, then one float conversion. */
export function rawToNumber(raw: string, decimals: number): number | null {
  if (!/^\d+$/.test(raw) || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return null;
  const big = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = big / base;
  const frac = big % base;
  return Number(whole) + (decimals === 0 ? 0 : Number(frac) / Number(base));
}

/** Decimal number → smallest-unit BigInt, rounded UP (so "enough balance?" checks are conservative). */
export function numberToRawCeil(value: number, decimals: number): bigint | null {
  if (!isFiniteNum(value) || value < 0 || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) return null;
  // toFixed handles up to 100 digits; use it to avoid float exponent formatting.
  const [whole, frac = ""] = value.toFixed(Math.min(decimals, 100)).split(".");
  const raw = BigInt(whole! + frac.padEnd(decimals, "0").slice(0, decimals));
  // Round up if precision was lost.
  const back = rawToNumber(raw.toString(), decimals);
  return back !== null && back < value ? raw + 1n : raw;
}

// ── Required functions ───────────────────────────────────────────────────────

/**
 * Signed absolute difference, USD per share: onChain − reference.
 * Positive = token trades at a premium to the reference.
 */
export function calculateSpread(onChainPerShare: number, referencePerShare: number): number | null {
  if (!isPos(onChainPerShare) || !isPos(referencePerShare)) return null;
  return onChainPerShare - referencePerShare;
}

/** Signed spread as a percent of the reference. 1.5 = 1.5% premium; −1.5 = 1.5% discount. */
export function calculateSpreadPercent(onChainPerShare: number, referencePerShare: number): number | null {
  const spread = calculateSpread(onChainPerShare, referencePerShare);
  return spread === null ? null : (spread / referencePerShare) * 100;
}

export interface ReferenceAge {
  ageMs: number;
  ageHours: number;
  /** True if asOf was in the future (clock skew); age is clamped to 0. */
  clockSkew: boolean;
}

/** Age of a reference observation. Returns null when the source gave no timestamp. */
export function calculateReferenceAge(asOf: number | null | undefined, now: number): ReferenceAge | null {
  if (!isFiniteNum(asOf) || !isFiniteNum(now)) return null;
  const raw = now - asOf;
  const ageMs = Math.max(0, raw);
  return { ageMs, ageHours: ageMs / 3_600_000, clockSkew: raw < 0 };
}

export interface SlippageEstimate {
  /** % of input value lost vs the on-chain mid. Negative = price improvement. */
  percent: number;
  method: "QUOTE_VS_MID" | "PRICE_IMPACT";
}

/**
 * Estimated execution slippage for the quoted trade, relative to the on-chain mid.
 *
 * Preferred (QUOTE_VS_MID): value the quote's input and output at the on-chain
 * token price and the quote's own stablecoin unit price; the shortfall is
 * everything execution costs beyond fees (impact, RFQ spread, routing).
 * Fallback (PRICE_IMPACT): the vendor's priceImpactPercent, when amounts can't be valued.
 */
export function estimateSlippage(quote: QuoteInput, tokenPriceUsd: number): SlippageEstimate | null {
  const fromAmt = rawToNumber(quote.fromAmountRaw, quote.fromDecimals);
  const toAmt = rawToNumber(quote.toAmountRaw, quote.toDecimals);
  const stable = quote.stableUnitPriceUsd;

  if (fromAmt !== null && toAmt !== null && fromAmt > 0 && isPos(tokenPriceUsd) && isPos(stable)) {
    let inValue: number;
    let outValue: number;
    if (quote.side === "BUY_TOKEN") {
      inValue = fromAmt * stable;
      outValue = toAmt * tokenPriceUsd;
    } else if (quote.side === "SELL_TOKEN") {
      inValue = fromAmt * tokenPriceUsd;
      outValue = toAmt * stable;
    } else {
      return null;
    }
    return { percent: ((inValue - outValue) / inValue) * 100, method: "QUOTE_VS_MID" };
  }
  if (isFiniteNum(quote.priceImpactPercent)) {
    return { percent: Math.abs(quote.priceImpactPercent), method: "PRICE_IMPACT" };
  }
  return null;
}

export interface NetOpportunity {
  /** |gross spread| − total costs, in percent. Can be negative. */
  netPercent: number;
  totalCostPercent: number;
  slippagePercent: number;
  gasPercent: number;
  taxPercent: number;
  /** Fraction of the gross spread consumed by costs (≥1 means costs exceed the spread). */
  costShareOfSpread: number;
  gasIncluded: boolean;
}

/**
 * Net opportunity after estimated execution costs, as a percent of notional.
 *
 * Returns null when slippage is unknown: without it the net figure would be a
 * fiction, and the engine will not report one. Price improvement (negative
 * slippage) is NOT credited — costs are floored at 0 to stay conservative.
 */
export function calculateNetOpportunity(args: {
  grossSpreadPercent: number;
  slippagePercent: number | null;
  gasUsd: number | null;
  taxPercent: number | null;
  notional: number;
}): NetOpportunity | null {
  const { grossSpreadPercent, slippagePercent, gasUsd, taxPercent, notional } = args;
  if (!isFiniteNum(grossSpreadPercent) || !isFiniteNum(slippagePercent) || !isPos(notional)) return null;

  const slip = Math.max(0, slippagePercent);
  const gasIncluded = isFiniteNum(gasUsd) && gasUsd >= 0;
  const gasPercent = gasIncluded ? (gasUsd / notional) * 100 : 0;
  const taxPct = isFiniteNum(taxPercent) ? Math.max(0, taxPercent) : 0;
  const totalCostPercent = slip + gasPercent + taxPct;
  const gross = Math.abs(grossSpreadPercent);

  return {
    netPercent: gross - totalCostPercent,
    totalCostPercent,
    slippagePercent: slip,
    gasPercent,
    taxPercent: taxPct,
    costShareOfSpread: gross > 0 ? totalCostPercent / gross : Number.POSITIVE_INFINITY,
    gasIncluded,
  };
}

/**
 * 0–100 ranking score. Deterministic and explainable:
 *   60 pts  net edge     — scales linearly up to 4× the policy's minimum net edge
 *   20 pts  liquidity    — known liquidity vs 10× the policy floor (0 if unknown)
 *   20 pts  confidence   — confidenceScore × 20
 * With no net estimate, the edge component uses at most a quarter of its range
 * from the gross spread, so unpriced opportunities never outrank priced ones.
 */
export function calculateOpportunityScore(args: {
  netOpportunityPercent: number | null;
  grossSpreadPercent: number;
  liquidityUsd: number | null;
  confidenceScore: number;
  policy: Pick<EnginePolicy, "minNetEdgeBps" | "minLiquidityUsd">;
}): number {
  const { netOpportunityPercent, grossSpreadPercent, liquidityUsd, confidenceScore, policy } = args;
  const targetPercent = (4 * policy.minNetEdgeBps) / 100;

  const edge =
    netOpportunityPercent !== null && isFiniteNum(netOpportunityPercent)
      ? clamp(netOpportunityPercent / targetPercent, 0, 1) * 60
      : clamp(Math.abs(grossSpreadPercent) / targetPercent, 0, 1) * 15;
  const liquidity = isPos(liquidityUsd) ? clamp(liquidityUsd / (10 * policy.minLiquidityUsd), 0, 1) * 20 : 0;
  const confidence = clamp(isFiniteNum(confidenceScore) ? confidenceScore : 0, 0, 1) * 20;

  return Math.round(edge + liquidity + confidence);
}
