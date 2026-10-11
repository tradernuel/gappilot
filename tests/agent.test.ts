import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/lib/agent/agent";
import { runAgentDeterministic } from "../src/lib/agent/deterministic";
import { checkProposal } from "../src/lib/agent/narrator";
import { DEFAULT_USER_RULES, UserRulesSchema, type AgentOutput, type UserRules } from "../src/lib/agent/types";
import { evaluateOpportunity } from "../src/lib/engine/evaluate";
import { numberToRawCeil } from "../src/lib/engine/calculations";
import type { Opportunity, OpportunityInput, QuoteInput } from "../src/lib/engine/types";
import type { MarketStatusView } from "../src/lib/rwa/rwa-service";

/*
 * All inputs are SYNTHETIC. The first scenario reproduces the example from the
 * agent specification (TSLA, $462 vs $450, 41 h reference, market closed,
 * $1.2M liquidity, 0.21% slippage, no tokens held). It is not market data.
 */
const NOW = 1_800_000_000_000;
const E18 = 10n ** 18n;
const OPEN: MarketStatusView = { available: true, openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null, nextOpenTime: null, nextCloseTime: null, isHardBlocked: false };
const CLOSED: MarketStatusView = { ...OPEN, openState: false, marketStatus: "closed", reasonCode: "MARKET_CLOSED", reasonMsg: "Weekend or Holiday" };

function quote(side: QuoteInput["side"], price: number, notional: number, slip: number): QuoteInput {
  const stable = (BigInt(Math.round(notional * 1e6)) * 10n ** 12n).toString();
  const tokens = numberToRawCeil(notional / price, 18)!.toString();
  return side === "SELL_TOKEN"
    ? { side, fromAmountRaw: tokens, fromDecimals: 18, toAmountRaw: (BigInt(Math.round(notional * (1 - slip / 100) * 1e6)) * 10n ** 12n).toString(), toDecimals: 18, stableUnitPriceUsd: 1, priceImpactPercent: slip, tradeFeeUsd: 0.05, taxRate: 0, isHoneyPot: false, executionMode: "RFQ", vendorName: "v", quoteId: "q", fetchedAt: NOW - 3_000 }
    : { side, fromAmountRaw: stable, fromDecimals: 18, toAmountRaw: numberToRawCeil((notional / price) * (1 - slip / 100), 18)!.toString(), toDecimals: 18, stableUnitPriceUsd: 1, priceImpactPercent: slip, tradeFeeUsd: 0.05, taxRate: 0, isHoneyPot: false, executionMode: "RFQ", vendorName: "v", quoteId: "q", fetchedAt: NOW - 3_000 };
}

function specExample(over: Partial<OpportunityInput> = {}): Opportunity {
  return evaluateOpportunity({
    asset: { address: "0x1111111111111111111111111111111111111111", issuer: "bstock", symbol: "TSLA", underlyingTicker: "TSLA", decimals: 18, tokenToShareRatio: 1 },
    onChain: { tokenPriceUsd: 462, updatedAt: NOW - 10_000 },
    reference: { kind: "EXTERNAL_OFFICIAL", perSharePriceUsd: 450, asOf: NOW - 41 * 3_600_000, source: "provider:official-close" },
    market: CLOSED,
    liquidity: { totalUsd: 1_200_000, poolCount: 3 },
    notional: 250,
    quote: quote("SELL_TOKEN", 462, 250, 0.21),
    wallet: { address: "0x2222222222222222222222222222222222222222", tokenBalanceRaw: "0", tokenDecimals: 18, stableBalanceRaw: (1000n * E18).toString(), stableDecimals: 18, fetchedAt: NOW },
    now: NOW,
    ...over,
  });
}

/** Cross-issuer baseline that the engine marks EXECUTABLE: +1% premium, 20 tokens held, open market. */
function crossIssuer(over: Partial<OpportunityInput> = {}): Opportunity {
  return evaluateOpportunity({
    asset: { address: "0x3333333333333333333333333333333333333333", issuer: "bstock", symbol: "XYZb", underlyingTicker: "XYZ", decimals: 18, tokenToShareRatio: 1 },
    onChain: { tokenPriceUsd: 101, updatedAt: NOW - 10_000 },
    reference: { kind: "CROSS_ISSUER", perSharePriceUsd: 100, asOf: NOW - 10_000, source: "ondo:XYZon" },
    market: OPEN,
    liquidity: { totalUsd: 1_000_000, poolCount: 3 },
    notional: 250,
    quote: quote("SELL_TOKEN", 101, 250, 0.2),
    wallet: { address: "0x4444444444444444444444444444444444444444", tokenBalanceRaw: (20n * E18).toString(), tokenDecimals: 18, stableBalanceRaw: (5000n * E18).toString(), stableDecimals: 18, fetchedAt: NOW },
    now: NOW,
    ...over,
  });
}

const contract = (a: AgentOutput) => ({ decision: a.decision, confidence: a.confidence, summary: a.summary, reasons: a.reasons, risks: a.risks, recommendedAction: a.recommendedAction });

describe("specification example", () => {
  it("reproduces the expected decision and summary", () => {
    const o = specExample();
    expect(o.action).toBe("ACTIONABLE"); // engine: market-side passes, wallet can't
    const a = runAgentDeterministic(o);
    expect(a.decision).toBe("WATCH");
    expect(a.summary).toBe(
      "TSLA is trading 2.67% above the last reference price while the US market is closed. " +
        "The reference is 41 hours old, so the divergence may reflect new information rather than a pure mispricing. " +
        "Because the wallet does not hold TSLA, spot execution cannot directly capture the premium.",
    );
    expect(a.recommendedAction).toBe("NO_ACTION");
    expect(a.mainRisk?.code).toBe("REFERENCE_STALE");
    expect(a.risks[0]).toMatch(/41 hours old/);
    expect(a.executableUnderRules).toBe(false);
    expect(a.reasons.some((r) => /cannot short/.test(r))).toBe(true);
  });

  it("returns exactly the required contract fields, all populated", () => {
    const c = contract(runAgentDeterministic(specExample()));
    expect(Object.keys(c)).toEqual(["decision", "confidence", "summary", "reasons", "risks", "recommendedAction"]);
    expect(c.reasons.length).toBeGreaterThan(0);
    expect(c.risks.length).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    expect(runAgentDeterministic(specExample())).toEqual(runAgentDeterministic(specExample()));
  });
});

describe("decision mapping (conservative)", () => {
  it("engine EXECUTABLE + rules pass + no HIGH risk → EXECUTABLE, SIMULATE (never execute)", () => {
    const a = runAgentDeterministic(crossIssuer());
    expect(a.engineAction).toBe("EXECUTABLE");
    expect([a.decision, a.recommendedAction]).toEqual(["EXECUTABLE", "SIMULATE"]);
    expect(a.summary).toMatch(/next step is a simulation/);
  });

  it("engine EXECUTABLE but a user rule fails → WATCH, WAIT", () => {
    const a = runAgentDeterministic(crossIssuer(), { ...DEFAULT_USER_RULES, minNetEdgePercent: 2 });
    expect([a.decision, a.recommendedAction]).toEqual(["WATCH", "WAIT"]);
    expect(a.ruleChecks.find((c) => c.rule === "MIN_NET_EDGE")?.passed).toBe(false);
    expect(a.reasons.some((r) => r.startsWith("Fails your rule"))).toBe(true);
  });

  it("engine EXECUTABLE with a HIGH main risk → ACTIONABLE, WAIT", () => {
    // Official reference, market closed, 2 h old: within rules, but stale-reference risk is HIGH.
    const o = crossIssuer({
      reference: { kind: "EXTERNAL_OFFICIAL", perSharePriceUsd: 100, asOf: NOW - 2 * 3_600_000, source: "provider:x" },
      market: CLOSED,
    });
    expect(o.action).toBe("EXECUTABLE");
    const a = runAgentDeterministic(o);
    expect([a.decision, a.recommendedAction]).toEqual(["ACTIONABLE", "WAIT"]);
    expect(a.confidence).not.toBe("HIGH");
  });

  it("discount without enough stablecoin → WATCH, NO_ACTION", () => {
    const o = crossIssuer({
      onChain: { tokenPriceUsd: 99, updatedAt: NOW - 10_000 },
      quote: quote("BUY_TOKEN", 99, 250, 0.2),
      wallet: { address: "0x4444444444444444444444444444444444444444", tokenBalanceRaw: "0", tokenDecimals: 18, stableBalanceRaw: (10n * E18).toString(), stableDecimals: 18, fetchedAt: NOW },
    });
    const a = runAgentDeterministic(o);
    expect([a.decision, a.recommendedAction]).toEqual(["WATCH", "NO_ACTION"]);
    expect(a.summary).toMatch(/lacks enough stablecoin/);
  });

  it("no wallet connected → at most ACTIONABLE, WAIT", () => {
    const a = runAgentDeterministic(crossIssuer({ wallet: null }));
    expect([a.decision, a.recommendedAction]).toEqual(["ACTIONABLE", "WAIT"]);
  });

  it("engine WATCH → WATCH, WAIT", () => {
    const a = runAgentDeterministic(crossIssuer({ quote: null }));
    expect([a.engineAction, a.decision, a.recommendedAction]).toEqual(["WATCH", "WATCH", "WAIT"]);
  });

  it("engine IGNORE → IGNORE, NO_ACTION, even with permissive rules", () => {
    const a = runAgentDeterministic(crossIssuer({ market: { ...OPEN, isHardBlocked: true, reasonCode: "ASSET_PAUSED", reasonMsg: "stock_split", openState: false } }));
    expect([a.decision, a.recommendedAction]).toEqual(["IGNORE", "NO_ACTION"]);
    expect(a.mainRisk?.code).toBe("CORPORATE_ACTION");
  });

  it("failed simulation → WATCH, NO_ACTION", () => {
    const a = runAgentDeterministic(crossIssuer({ simulation: { status: "FAILED", failReason: "reverted" } }));
    expect([a.decision, a.recommendedAction]).toEqual(["WATCH", "NO_ACTION"]);
  });

  it("allowMarketClosed=false blocks off-hours execution", () => {
    const a = runAgentDeterministic(crossIssuer({ market: CLOSED }), { ...DEFAULT_USER_RULES, allowMarketClosed: false });
    expect(a.decision).not.toBe("EXECUTABLE");
    expect(a.ruleChecks.find((c) => c.rule === "MARKET_CLOSED")?.passed).toBe(false);
  });

  it("unknown data fails the corresponding rule (conservative)", () => {
    const a = runAgentDeterministic(crossIssuer({ reference: { kind: "CROSS_ISSUER", perSharePriceUsd: 100, asOf: null, source: "ondo:XYZon" } }));
    expect(a.ruleChecks.find((c) => c.rule === "MAX_REFERENCE_AGE")?.passed).toBe(false);
    expect(a.decision).not.toBe("EXECUTABLE");
  });
});

describe("never overrides risk limits", () => {
  const loosest: UserRules = { maxNotionalUsd: 1_000_000, minNetEdgePercent: 0, maxSlippagePercent: 10, maxReferenceAgeHours: 720, minConfidence: "LOW", allowMarketClosed: true };

  it.each([
    ["WATCH (no quote)", () => crossIssuer({ quote: null })],
    ["ACTIONABLE (no holdings)", () => specExample()],
    ["IGNORE (noise)", () => crossIssuer({ onChain: { tokenPriceUsd: 100.1, updatedAt: NOW - 10_000 }, quote: null })],
  ])("the loosest user rules can't lift %s above the engine", (_label, make) => {
    const o = make();
    const a = runAgentDeterministic(o, loosest);
    const rank = { IGNORE: 0, WATCH: 1, ACTIONABLE: 2, EXECUTABLE: 3 } as const;
    expect(rank[a.decision]).toBeLessThanOrEqual(rank[o.action]);
    expect(a.recommendedAction).not.toBe("SIMULATE");
  });

  it("rejects out-of-range user rules", () => {
    expect(UserRulesSchema.safeParse({ ...DEFAULT_USER_RULES, maxSlippagePercent: 50 }).success).toBe(false);
    expect(UserRulesSchema.safeParse({ ...DEFAULT_USER_RULES, extra: 1 }).success).toBe(false);
  });
});

describe("output safety", () => {
  const scenarios = () => [specExample(), crossIssuer(), crossIssuer({ wallet: null }), crossIssuer({ quote: null }), crossIssuer({ market: CLOSED })];

  it("never claims guaranteed or risk-free outcomes and never instructs a trade", () => {
    const banned = /guarantee|risk[- ]?free|riskless|sure profit|\b(?:buy|sell|execute)\s+(?:now|immediately)\b/i;
    for (const o of scenarios()) {
      const a = runAgentDeterministic(o);
      for (const t of [a.summary, ...a.reasons, ...a.risks]) expect(t).not.toMatch(banned);
    }
  });

  it("contains no calldata or addresses in any text", () => {
    for (const o of scenarios()) {
      const a = runAgentDeterministic(o);
      expect([a.summary, ...a.reasons, ...a.risks].join(" ")).not.toMatch(/0x[0-9a-fA-F]{6,}/);
    }
  });

  it("the agent module cannot reach market APIs, wallets or transaction builders", () => {
    const dir = path.join(__dirname, "../src/lib/agent");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(path.join(dir, f), "utf8");
      expect(src).not.toMatch(/from ["'][^"']*binance\/(?:facade|client|http|modules)/);
      expect(src).not.toMatch(/buildSwap|submitRfq|broadcast|signTypedData|eth_send/);
    }
  });
});

describe("LLM narrator guardrails", () => {
  const fakeLlm = (...replies: object[]) => {
    const q = [...replies];
    return vi.fn(async () => new Response(JSON.stringify({ model: "test-model", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(q.shift()) }] }] }), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  };
  const deps = (f: typeof fetch) => ({ narrate: { apiKey: "k", model: "m", fetchImpl: f } });
  const goodSummary = "TSLA trades 2.67% above the last reference price, which is 41 hours old while the market is closed. The gap may reflect news rather than mispricing, and the wallet holds no TSLA to sell.";

  it("uses a verified summary and accepts a MORE conservative proposal", async () => {
    const f = fakeLlm({ summary: goodSummary, decision: "IGNORE", recommendedAction: "NO_ACTION", confidence: "LOW", mainRiskCode: "REFERENCE_STALE" });
    const a = await runAgent(specExample(), DEFAULT_USER_RULES, deps(f));
    expect(a.source).toBe("deterministic+llm_summary");
    expect([a.decision, a.recommendedAction, a.confidence]).toEqual(["IGNORE", "NO_ACTION", "LOW"]);
    expect(a.guardrails).toMatchObject({ llm: "verified", clamped: [] });
    const body = JSON.parse(String(f.mock.calls[0]![1]!.body));
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true });
  });

  it("clamps a LESS conservative proposal back to the policy", async () => {
    const f = fakeLlm({ summary: goodSummary, decision: "EXECUTABLE", recommendedAction: "SIMULATE", confidence: "HIGH", mainRiskCode: "REFERENCE_STALE" });
    const a = await runAgent(specExample(), DEFAULT_USER_RULES, deps(f));
    expect([a.decision, a.recommendedAction, a.confidence]).toEqual(["WATCH", "NO_ACTION", "MEDIUM"]);
    expect(a.guardrails.clamped).toEqual(["decision", "recommendedAction", "confidence"]);
  });

  it("discards the proposal if the summary invents a number (after one retry)", async () => {
    const bad = { summary: "TSLA trades at $470 with $5,000,000 liquidity.", decision: "WATCH", recommendedAction: "NO_ACTION", confidence: "MEDIUM", mainRiskCode: "REFERENCE_STALE" };
    const f = fakeLlm(bad, bad);
    const a = await runAgent(specExample(), DEFAULT_USER_RULES, deps(f));
    expect(f).toHaveBeenCalledTimes(2);
    expect(a.source).toBe("deterministic");
    expect(a.guardrails.llm).toBe("rejected");
    expect(a.summary).toBe(runAgentDeterministic(specExample()).summary);
  });

  it.each([
    ["calldata", "Approve with 0x095ea7b3000000 then proceed. The gap is 2.67%."],
    ["a trade instruction", "Sell now while the gap is 2.67%."],
    ["guaranteed language", "A guaranteed 2.67% gain."],
  ])("rejects a summary containing %s", (_label, summary) => {
    const base = runAgentDeterministic(specExample());
    const r = checkProposal(JSON.stringify({ summary, decision: "WATCH", recommendedAction: "WAIT", confidence: "LOW", mainRiskCode: "REFERENCE_STALE" }), {
      opportunity: specExample(),
      policy: { decision: base.decision, recommendedAction: base.recommendedAction, confidence: base.confidence, risks: base.riskDetails, mainRisk: base.mainRisk, ruleChecks: base.ruleChecks, rules: base.rules, reasons: base.reasons, summary: base.summary },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects non-JSON replies", () => {
    const base = runAgentDeterministic(specExample());
    expect(checkProposal("not json", { opportunity: specExample(), policy: { ...base, risks: base.riskDetails, rules: base.rules } as never }).ok).toBe(false);
  });

  it("falls back to deterministic output when the LLM is not configured or errors", async () => {
    const a = await runAgent(specExample(), DEFAULT_USER_RULES, { narrate: {} });
    expect(a.guardrails.llm).toBe("not_configured");
    const err = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const b = await runAgent(specExample(), DEFAULT_USER_RULES, deps(err));
    expect(b.guardrails.llm).toBe("error");
    expect(contract(b)).toEqual(contract(runAgentDeterministic(specExample())));
  });
});

describe("summary wording", () => {
  it("does not repeat that the market is closed", () => {
    const a = runAgentDeterministic(crossIssuer({ market: CLOSED }));
    expect(a.mainRisk?.code).toBe("OFF_HOURS");
    expect(a.summary.match(/market is closed/g)?.length).toBe(1);
  });
});
