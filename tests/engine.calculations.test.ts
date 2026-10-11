import { describe, expect, it } from "vitest";
import {
  calculateNetOpportunity,
  calculateOpportunityScore,
  calculateReferenceAge,
  calculateSpread,
  calculateSpreadPercent,
  estimateSlippage,
  numberToRawCeil,
  perSharePrice,
  rawToNumber,
} from "../src/lib/engine/calculations";
import { DEFAULT_POLICY, type QuoteInput } from "../src/lib/engine/types";

// All numbers are synthetic, chosen so results can be checked by hand. Not market data.

describe("calculateSpread / calculateSpreadPercent", () => {
  it("is signed: premium positive, discount negative", () => {
    expect(calculateSpread(101, 100)).toBeCloseTo(1);
    expect(calculateSpread(99, 100)).toBeCloseTo(-1);
    expect(calculateSpreadPercent(101, 100)).toBeCloseTo(1);
    expect(calculateSpreadPercent(95, 100)).toBeCloseTo(-5);
  });

  it("is relative to the reference", () => {
    expect(calculateSpreadPercent(110, 100)).toBeCloseTo(10);
    expect(calculateSpreadPercent(100, 110)).toBeCloseTo(-9.0909, 3);
  });

  it("returns null for non-positive or non-finite inputs", () => {
    for (const [a, b] of [[0, 100], [100, 0], [-1, 100], [NaN, 100], [100, Infinity]] as const) {
      expect(calculateSpread(a, b)).toBeNull();
      expect(calculateSpreadPercent(a, b)).toBeNull();
    }
  });
});

describe("perSharePrice", () => {
  it("normalises by tokenToShareRatio so different issuers compare per share", () => {
    expect(perSharePrice(200, 2)).toBe(100);
    expect(perSharePrice(100, 1)).toBe(100);
    expect(perSharePrice(100, 0)).toBeNull();
  });
});

describe("calculateReferenceAge", () => {
  it("returns ms and hours", () => {
    const age = calculateReferenceAge(0, 2 * 3_600_000);
    expect(age).toEqual({ ageMs: 7_200_000, ageHours: 2, clockSkew: false });
  });
  it("returns null without a timestamp", () => {
    expect(calculateReferenceAge(null, 1)).toBeNull();
    expect(calculateReferenceAge(undefined, 1)).toBeNull();
  });
  it("clamps future timestamps to 0 and flags clock skew", () => {
    expect(calculateReferenceAge(10_000, 5_000)).toEqual({ ageMs: 0, ageHours: 0, clockSkew: true });
  });
});

describe("calculateNetOpportunity", () => {
  it("subtracts slippage, gas and tax from the absolute gross spread", () => {
    const net = calculateNetOpportunity({ grossSpreadPercent: -2, slippagePercent: 0.5, gasUsd: 1, taxPercent: 0.1, notional: 1000 })!;
    expect(net.gasPercent).toBeCloseTo(0.1);
    expect(net.totalCostPercent).toBeCloseTo(0.7);
    expect(net.netPercent).toBeCloseTo(1.3);
    expect(net.costShareOfSpread).toBeCloseTo(0.35);
    expect(net.gasIncluded).toBe(true);
  });

  it("returns null when slippage is unknown (no fictional net figure)", () => {
    expect(calculateNetOpportunity({ grossSpreadPercent: 5, slippagePercent: null, gasUsd: 1, taxPercent: 0, notional: 1000 })).toBeNull();
  });

  it("does not credit price improvement (negative slippage floored at 0)", () => {
    const net = calculateNetOpportunity({ grossSpreadPercent: 1, slippagePercent: -0.3, gasUsd: 0, taxPercent: 0, notional: 1000 })!;
    expect(net.netPercent).toBe(1);
  });

  it("flags when gas is missing", () => {
    expect(calculateNetOpportunity({ grossSpreadPercent: 1, slippagePercent: 0, gasUsd: null, taxPercent: null, notional: 100 })!.gasIncluded).toBe(false);
  });

  it("can be negative when costs exceed the spread", () => {
    expect(calculateNetOpportunity({ grossSpreadPercent: 0.3, slippagePercent: 0.5, gasUsd: 0, taxPercent: 0, notional: 100 })!.netPercent).toBeCloseTo(-0.2);
  });
});

describe("calculateOpportunityScore", () => {
  const policy = { minNetEdgeBps: 50, minLiquidityUsd: 25_000 };
  it("is bounded 0–100", () => {
    expect(calculateOpportunityScore({ netOpportunityPercent: 100, grossSpreadPercent: 100, liquidityUsd: 1e12, confidenceScore: 1, policy })).toBe(100);
    expect(calculateOpportunityScore({ netOpportunityPercent: -5, grossSpreadPercent: 0, liquidityUsd: null, confidenceScore: 0, policy })).toBe(0);
  });
  it("increases with net edge", () => {
    const s = (n: number) => calculateOpportunityScore({ netOpportunityPercent: n, grossSpreadPercent: 3, liquidityUsd: 1e6, confidenceScore: 1, policy });
    expect(s(1)).toBeGreaterThan(s(0.5));
  });
  it("never ranks an unpriced opportunity above a priced one with the same inputs", () => {
    const priced = calculateOpportunityScore({ netOpportunityPercent: 2, grossSpreadPercent: 2.5, liquidityUsd: 1e6, confidenceScore: 1, policy });
    const unpriced = calculateOpportunityScore({ netOpportunityPercent: null, grossSpreadPercent: 50, liquidityUsd: 1e6, confidenceScore: 1, policy });
    expect(unpriced).toBeLessThan(priced);
  });
});

describe("estimateSlippage", () => {
  const base: QuoteInput = {
    side: "BUY_TOKEN", fromAmountRaw: "1000000000000000000000", fromDecimals: 18, toAmountRaw: "9980000000000000000", toDecimals: 18,
    stableUnitPriceUsd: 1, priceImpactPercent: 0.1, tradeFeeUsd: 0.05, taxRate: 0, isHoneyPot: false,
    executionMode: "RFQ", vendorName: "X", quoteId: "q", fetchedAt: 0,
  };
  it("BUY: 1000 USDT → 9.98 tokens at $100 mid = 0.2% shortfall", () => {
    expect(estimateSlippage(base, 100)).toEqual({ percent: expect.closeTo(0.2, 9), method: "QUOTE_VS_MID" });
  });
  it("SELL: 10 tokens at $100 → 997 USDT = 0.3% shortfall", () => {
    const q = { ...base, side: "SELL_TOKEN" as const, fromAmountRaw: "10000000000000000000", toAmountRaw: "997000000000000000000" };
    expect(estimateSlippage(q, 100)!.percent).toBeCloseTo(0.3, 9);
  });
  it("falls back to |priceImpact| when the stablecoin price is unknown", () => {
    expect(estimateSlippage({ ...base, stableUnitPriceUsd: null, priceImpactPercent: -0.4 }, 100)).toEqual({ percent: 0.4, method: "PRICE_IMPACT" });
  });
  it("returns null with nothing usable", () => {
    expect(estimateSlippage({ ...base, stableUnitPriceUsd: null, priceImpactPercent: null }, 100)).toBeNull();
  });
});

describe("unit conversion", () => {
  it("rawToNumber handles 18 decimals exactly at the integer boundary", () => {
    expect(rawToNumber("1500000000000000000", 18)).toBe(1.5);
    expect(rawToNumber("12", 0)).toBe(12);
    expect(rawToNumber("1.5", 18)).toBeNull();
  });
  it("numberToRawCeil rounds up (conservative for balance checks)", () => {
    expect(numberToRawCeil(1.5, 6)).toBe(1_500_000n);
    expect(numberToRawCeil(1 / 3, 6)! >= 333_333n).toBe(true);
    expect(numberToRawCeil(-1, 6)).toBeNull();
  });
});

it("default policy matches the documented thresholds", () => {
  expect(DEFAULT_POLICY).toMatchObject({ minSpreadBps: 25, minNetEdgeBps: 50, maxQuoteAgeMs: 30_000, maxCostShareOfSpread: 0.5 });
});
