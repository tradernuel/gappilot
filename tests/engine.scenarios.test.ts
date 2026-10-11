import { describe, expect, it } from "vitest";
import { evaluateOpportunity, EngineInputError, rankOpportunities } from "../src/lib/engine/evaluate";
import { numberToRawCeil } from "../src/lib/engine/calculations";
import type { Opportunity, OpportunityInput, QuoteInput } from "../src/lib/engine/types";
import type { MarketStatusView } from "../src/lib/rwa/rwa-service";

/*
 * Scenario builder. All values are SYNTHETIC and chosen for hand-checkable
 * arithmetic. They are not market data.
 *
 * Baseline: token at $101/share vs a cross-issuer reference of $100 → +1% premium.
 * The wallet holds 20 tokens, so selling $1,000 is possible. The SELL quote
 * returns 998 USDT for $1,000 of tokens at mid (0.2% slippage) and $0.05 gas.
 * Net ≈ 1% − 0.2% − 0.005% = 0.795% ≥ 0.5% → EXECUTABLE.
 */
const NOW = 1_800_000_000_000;
const E18 = 10n ** 18n;

const OPEN: MarketStatusView = {
  available: true, openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null,
  nextOpenTime: null, nextCloseTime: null, isHardBlocked: false,
};
const CLOSED: MarketStatusView = {
  ...OPEN, openState: false, marketStatus: "closed", reasonCode: "MARKET_CLOSED", reasonMsg: "Weekend or Holiday", nextOpenTime: NOW + 3_600_000,
};

function sellQuote(tokenPrice: number, notional: number, slippagePct: number, over: Partial<QuoteInput> = {}): QuoteInput {
  const tokensIn = numberToRawCeil(notional / tokenPrice, 18)!;
  const usdtOut = BigInt(Math.round(notional * (1 - slippagePct / 100) * 1e6)) * 10n ** 12n;
  return {
    side: "SELL_TOKEN", fromAmountRaw: tokensIn.toString(), fromDecimals: 18, toAmountRaw: usdtOut.toString(), toDecimals: 18,
    stableUnitPriceUsd: 1, priceImpactPercent: slippagePct, tradeFeeUsd: 0.05, taxRate: 0, isHoneyPot: false,
    executionMode: "RFQ", vendorName: "PcsXRfq", quoteId: "q1", fetchedAt: NOW - 5_000, ...over,
  };
}

function buyQuote(tokenPrice: number, notional: number, slippagePct: number, over: Partial<QuoteInput> = {}): QuoteInput {
  const usdtIn = BigInt(Math.round(notional * 1e6)) * 10n ** 12n;
  const tokensOut = numberToRawCeil((notional / tokenPrice) * (1 - slippagePct / 100), 18)!;
  return {
    side: "BUY_TOKEN", fromAmountRaw: usdtIn.toString(), fromDecimals: 18, toAmountRaw: tokensOut.toString(), toDecimals: 18,
    stableUnitPriceUsd: 1, priceImpactPercent: slippagePct, tradeFeeUsd: 0.05, taxRate: 0, isHoneyPot: false,
    executionMode: "RFQ", vendorName: "PcsXRfq", quoteId: "q2", fetchedAt: NOW - 5_000, ...over,
  };
}

function scenario(over: Partial<OpportunityInput> = {}): OpportunityInput {
  return {
    asset: { address: "0xaaaa", issuer: "bstock", symbol: "XYZB", underlyingTicker: "XYZ", decimals: 18, tokenToShareRatio: 1 },
    onChain: { tokenPriceUsd: 101, updatedAt: NOW - 10_000 },
    reference: {
      kind: "CROSS_ISSUER", perSharePriceUsd: 100, asOf: NOW - 10_000, source: "ondo:XYZon",
      counterpart: { address: "0xbbbb", issuer: "ondo", symbol: "XYZon" },
    },
    market: OPEN,
    liquidity: { totalUsd: 1_000_000, poolCount: 3 },
    notional: 1_000,
    quote: sellQuote(101, 1_000, 0.2),
    wallet: { address: "0xwallet", tokenBalanceRaw: (20n * E18).toString(), tokenDecimals: 18, stableBalanceRaw: (5_000n * E18).toString(), stableDecimals: 18, fetchedAt: NOW },
    now: NOW,
    ...over,
  };
}

const run = (over: Partial<OpportunityInput> = {}) => evaluateOpportunity(scenario(over));
const has = (o: Opportunity, re: RegExp) => o.reasons.some((r) => re.test(r));

describe("baseline", () => {
  it("premium + holdings + priced + liquid + fresh → EXECUTABLE", () => {
    const o = run();
    expect(o.action).toBe("EXECUTABLE");
    expect(o.direction).toBe("PREMIUM");
    expect(o.spotAction).toBe("SELL_TOKEN");
    expect(o.spreadPercent).toBeCloseTo(1);
    expect(o.absoluteSpreadUsd).toBeCloseTo(1);
    expect(o.estimatedSlippagePercent).toBeCloseTo(0.2, 4);
    expect(o.estimatedGasUsd).toBe(0.05);
    expect(o.netOpportunityPercent).toBeCloseTo(0.795, 3);
    expect(o.confidence).toBe("HIGH");
    expect(o.walletPosition).toMatchObject({ connected: true, tokenBalance: 20, canSellNotional: true });
    expect(o.score).toBeGreaterThan(50);
    expect(has(o, /Simulate before submitting/)).toBe(true);
  });

  it("returns every field of the Opportunity contract", () => {
    const o = run();
    for (const k of [
      "asset", "onChainPrice", "referencePrice", "spreadPercent", "referenceAgeHours", "marketStatus", "liquidityUsd",
      "estimatedSlippagePercent", "estimatedGasUsd", "netOpportunityPercent", "walletPosition", "action", "confidence", "reasons",
    ]) expect(o).toHaveProperty(k);
  });

  it("is deterministic", () => {
    expect(run()).toEqual(run());
  });
});

describe("a large spread alone is not an opportunity", () => {
  it("10% premium with no quote → WATCH, net not reported", () => {
    const o = run({ onChain: { tokenPriceUsd: 110, updatedAt: NOW - 10_000 }, quote: null });
    expect(o.spreadPercent).toBeCloseTo(10);
    expect(o.action).toBe("WATCH");
    expect(o.netOpportunityPercent).toBeNull();
  });

  it("10% premium with no wallet → no quote possible for RFQ → WATCH", () => {
    const o = run({ onChain: { tokenPriceUsd: 110, updatedAt: NOW - 10_000 }, quote: null, wallet: null });
    expect(o.action).toBe("WATCH");
    expect(has(o, /requires a connected wallet/)).toBe(true);
  });
});

describe("market closed", () => {
  it("external official reference → explicitly potentially stale, lower confidence", () => {
    const o = run({
      market: CLOSED,
      reference: { kind: "EXTERNAL_OFFICIAL", perSharePriceUsd: 100, asOf: NOW - 40 * 3_600_000, source: "provider:test" },
    });
    expect(o.referencePotentiallyStale).toBe(true);
    expect(o.referenceAgeHours).toBeCloseTo(40);
    expect(has(o, /potentially stale/)).toBe(true);
    expect(has(o, /news since the close/)).toBe(true);
    expect(o.confidenceScore).toBeLessThan(1);
  });

  it("cross-issuer reference → closed is stated, but the on-chain reference isn't the stale one", () => {
    const o = run({ market: CLOSED });
    expect(o.referencePotentiallyStale).toBe(false);
    expect(has(o, /traditional market is closed/i)).toBe(true);
    expect(o.confidenceScore).toBeCloseTo(0.85);
  });
});

describe("liquidity", () => {
  it("below the floor → WATCH", () => {
    const o = run({ liquidity: { totalUsd: 10_000, poolCount: 1 } });
    expect(o.action).toBe("WATCH");
    expect(has(o, /below the \$25,000 minimum/)).toBe(true);
  });

  it("trade larger than 2% of liquidity → WATCH", () => {
    const o = run({ liquidity: { totalUsd: 30_000, poolCount: 1 } }); // 2% = $600 < $1,000
    expect(o.action).toBe("WATCH");
    expect(has(o, /exceeds 2% of known liquidity/)).toBe(true);
  });

  it("unknown liquidity and no quote → WATCH", () => {
    expect(run({ liquidity: null, quote: null }).action).toBe("WATCH");
  });

  it("unknown liquidity but a quote exists → not capped, confidence lowered", () => {
    const o = run({ liquidity: null });
    expect(o.action).toBe("EXECUTABLE");
    expect(o.confidenceScore).toBeCloseTo(0.8);
  });
});

describe("costs", () => {
  it("slippage consuming most of the spread → WATCH", () => {
    const o = run({ quote: sellQuote(101, 1_000, 0.7) }); // 0.7 of a 1% spread
    expect(o.action).toBe("WATCH");
    expect(has(o, /consume \d+% of the 1\.00% spread/)).toBe(true);
  });

  it("net edge below threshold → WATCH", () => {
    const o = run({ onChain: { tokenPriceUsd: 100.6, updatedAt: NOW - 10_000 }, quote: sellQuote(100.6, 1_000, 0.2) });
    // 0.6% − 0.2% − 0.005% = 0.395% < 0.5%
    expect(o.netOpportunityPercent).toBeCloseTo(0.395, 2);
    expect(o.action).toBe("WATCH");
  });

  it("missing gas estimate is disclosed and lowers confidence", () => {
    const o = run({ quote: sellQuote(101, 1_000, 0.2, { tradeFeeUsd: null }) });
    expect(o.estimatedGasUsd).toBeNull();
    expect(has(o, /gas is not in the net figure/)).toBe(true);
  });

  it("token tax is included in costs", () => {
    const o = run({ quote: sellQuote(101, 1_000, 0.2, { taxRate: 0.001 }) });
    expect(o.estimatedTaxPercent).toBeCloseTo(0.1);
    expect(o.netOpportunityPercent).toBeCloseTo(0.695, 3);
  });
});

describe("wallet capability (spot only)", () => {
  it("premium with no token position → ACTIONABLE, cannot short", () => {
    const o = run({ wallet: { ...scenario().wallet!, tokenBalanceRaw: "0" } });
    expect(o.action).toBe("ACTIONABLE");
    expect(o.walletPosition.canSellNotional).toBe(false);
    expect(has(o, /cannot short/)).toBe(true);
  });

  it("premium with a position smaller than the size → ACTIONABLE", () => {
    const o = run({ wallet: { ...scenario().wallet!, tokenBalanceRaw: (1n * E18).toString() } });
    expect(o.action).toBe("ACTIONABLE");
    expect(has(o, /smaller than the evaluated size/)).toBe(true);
  });

  const discount = (stableRaw: bigint) =>
    run({
      onChain: { tokenPriceUsd: 99, updatedAt: NOW - 10_000 },
      quote: buyQuote(99, 1_000, 0.2),
      wallet: { ...scenario().wallet!, tokenBalanceRaw: "0", stableBalanceRaw: stableRaw.toString() },
    });

  it("discount with insufficient stablecoin → ACTIONABLE, not executable", () => {
    const o = discount(500n * E18);
    expect(o.direction).toBe("DISCOUNT");
    expect(o.spotAction).toBe("BUY_TOKEN");
    expect(o.action).toBe("ACTIONABLE");
    expect(has(o, /Insufficient stablecoin/)).toBe(true);
  });

  it("discount with enough stablecoin → EXECUTABLE (holding the token is not required)", () => {
    const o = discount(1_000n * E18);
    expect(o.action).toBe("EXECUTABLE");
    expect(o.walletPosition.canBuyNotional).toBe(true);
  });

  it("no wallet connected → at most ACTIONABLE", () => {
    const o = run({ wallet: null });
    expect(o.action).toBe("ACTIONABLE");
    expect(o.walletPosition.connected).toBe(false);
  });
});

describe("stale data", () => {
  it("stale on-chain price → confidence down and not EXECUTABLE", () => {
    const o = run({ onChain: { tokenPriceUsd: 101, updatedAt: NOW - 10 * 60_000 } });
    expect(o.action).toBe("ACTIONABLE");
    expect(o.confidenceScore).toBeCloseTo(0.6);
    expect(has(o, /refresh before acting/)).toBe(true);
  });

  it("stale counterpart price → not EXECUTABLE", () => {
    const o = run({ reference: { ...scenario().reference, asOf: NOW - 10 * 60_000 } });
    expect(o.action).toBe("ACTIONABLE");
  });

  it("expired quote → re-quote required", () => {
    const o = run({ quote: sellQuote(101, 1_000, 0.2, { fetchedAt: NOW - 60_000 }) });
    expect(o.action).toBe("ACTIONABLE");
    expect(has(o, /re-quote/)).toBe(true);
  });

  it("stacked data-quality problems → LOW confidence blocks EXECUTABLE", () => {
    const o = run({
      onChain: { tokenPriceUsd: 101, updatedAt: null },
      reference: { ...scenario().reference, asOf: null },
      market: { ...OPEN, available: false },
      liquidity: null,
    });
    expect(o.confidence).toBe("LOW");
    expect(o.action).not.toBe("EXECUTABLE");
  });
});

describe("IGNORE cases", () => {
  it("spread inside the noise band", () => {
    const o = run({ onChain: { tokenPriceUsd: 100.1, updatedAt: NOW - 10_000 }, quote: null });
    expect(o.action).toBe("IGNORE");
    expect(o.score).toBe(0);
  });

  it("reference derived from the token itself (API referencePrice)", () => {
    const o = run({ reference: { kind: "BINANCE_DERIVED", perSharePriceUsd: 95, asOf: NOW, source: "binance:referencePrice" } });
    expect(o.action).toBe("IGNORE");
    expect(has(o, /not an independent signal/)).toBe(true);
  });

  it("corporate action / asset paused", () => {
    const o = run({ market: { ...OPEN, openState: false, reasonCode: "ASSET_PAUSED", reasonMsg: "stock_split", isHardBlocked: true } });
    expect(o.action).toBe("IGNORE");
    expect(has(o, /stock_split/)).toBe(true);
  });

  it("honeypot token", () => {
    expect(run({ quote: sellQuote(101, 1_000, 0.2, { isHoneyPot: true }) }).action).toBe("IGNORE");
  });
});

describe("other rules", () => {
  it("failed simulation caps at ACTIONABLE", () => {
    const o = run({ simulation: { status: "FAILED", failReason: "insufficient allowance" } });
    expect(o.action).toBe("ACTIONABLE");
    expect(has(o, /insufficient allowance/)).toBe(true);
  });

  it("a quote for the wrong side is not used as evidence", () => {
    const o = run({ quote: buyQuote(101, 1_000, 0.2) });
    expect(o.estimatedSlippagePercent).toBeNull();
    expect(o.action).toBe("WATCH");
    expect(has(o, /was not used/)).toBe(true);
  });

  it("per-share normalisation: different ratios, same per-share price → no false spread", () => {
    const o = run({ asset: { ...scenario().asset, tokenToShareRatio: 2 }, onChain: { tokenPriceUsd: 200, updatedAt: NOW - 10_000 }, quote: null });
    expect(o.onChainPrice).toBe(100);
    expect(o.spreadPercent).toBe(0);
    expect(o.direction).toBe("NONE");
    expect(o.action).toBe("IGNORE");
  });

  it("stablecoin depeg lowers confidence", () => {
    const o = run({ quote: sellQuote(101, 1_000, 0.2, { stableUnitPriceUsd: 0.98 }) });
    expect(has(o, /away from \$1/)).toBe(true);
    expect(o.confidenceScore).toBeLessThan(1);
  });

  it("rejects meaningless inputs", () => {
    expect(() => run({ onChain: { tokenPriceUsd: 0, updatedAt: NOW } })).toThrow(EngineInputError);
    expect(() => run({ reference: { ...scenario().reference, perSharePriceUsd: -1 } })).toThrow(EngineInputError);
    expect(() => run({ notional: 0 })).toThrow(EngineInputError);
  });

  it("ranks EXECUTABLE above ACTIONABLE above WATCH above IGNORE", () => {
    const list = [
      run({ onChain: { tokenPriceUsd: 100.1, updatedAt: NOW - 10_000 }, quote: null }),
      run({ wallet: null }),
      run(),
      run({ quote: null }),
    ];
    expect(rankOpportunities(list).map((o) => o.action)).toEqual(["EXECUTABLE", "ACTIONABLE", "WATCH", "IGNORE"]);
  });
});

describe("language safety", () => {
  const all = [
    run(), run({ quote: null }), run({ wallet: null }), run({ market: CLOSED }),
    run({ reference: { kind: "EXTERNAL_OFFICIAL", perSharePriceUsd: 100, asOf: NOW - 3_600_000, source: "p" }, market: CLOSED }),
    run({ onChain: { tokenPriceUsd: 150, updatedAt: NOW - 10_000 }, quote: sellQuote(150, 1_000, 0.1) }),
  ];

  it("never claims guaranteed profit or risk-free trades", () => {
    const banned = /guarantee|risk[- ]?free|riskless|no[- ]risk|sure (?:profit|thing)|free money|arbitrage profit/i;
    for (const o of all) {
      for (const r of o.reasons) expect(r).not.toMatch(banned);
      for (const g of o.gates) expect(g.detail).not.toMatch(banned);
    }
  });

  it("always carries the uncertainty disclaimer", () => {
    for (const o of all) expect(o.disclaimer).toMatch(/losses are possible/);
  });
});
