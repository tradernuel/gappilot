import { describe, expect, it, vi } from "vitest";
import { compileStrategy } from "../src/lib/strategy/compile";
import { parseWithRules } from "../src/lib/strategy/rules-parser";
import { parseWithLlm } from "../src/lib/strategy/llm-parser";
import { describeStrategy } from "../src/lib/strategy/describe";
import { matchStrategy } from "../src/lib/strategy/match";
import { extractNumbers } from "../src/lib/strategy/text";
import { StrategySchema, type Extraction, type Strategy } from "../src/lib/strategy/schema";
import type { Opportunity } from "../src/lib/engine/types";

const EXAMPLE = "Buy tokenized stocks when they are at least 2% below reference price. Only trade when liquidity is above $100k. Maximum $50 per trade.";
const viaRules = (t: string) => compileStrategy(t, parseWithRules(t), "rules");
const codes = (t: string) => viaRules(t).errors.map((e) => e.code);

/** What a well-behaved LLM would return for EXAMPLE. Tests mutate copies of it. */
const llmExtraction = (over: Partial<Extraction> = {}): Extraction => ({
  action: "BUY",
  unsupportedAction: null,
  assetScope: { type: "ALL", tickers: [], issuers: [] },
  spreadThresholdPercent: -2,
  minimumLiquidityUsd: 100_000,
  maximumTradeUsd: 50,
  maximumSlippagePercent: null,
  marketStatus: null,
  requireSimulation: null,
  flags: { leverage: false, derivatives: false, short: false, autoExecute: false },
  ambiguities: [],
  quotes: { spread: "at least 2% below reference price", liquidity: "liquidity is above $100k", maximumTrade: "Maximum $50 per trade", slippage: null },
  ...over,
});

describe("specification example", () => {
  const expected = {
    version: 1,
    action: "BUY",
    assetScope: { type: "ALL" },
    spreadThresholdPercent: -2,
    minimumLiquidityUsd: 100_000,
    maximumTradeUsd: 50,
    maximumSlippagePercent: 0.5,
    marketStatus: "ANY",
    requireSimulation: true,
    sourceText: EXAMPLE,
  };

  it("compiles via the rule-based parser", () => {
    const r = viaRules(EXAMPLE);
    expect(r.ok).toBe(true);
    expect(r.strategy).toEqual(expected);
    expect(r.defaultsApplied).toEqual(["maximumSlippagePercent", "marketStatus"]);
  });

  it("compiles identically from an LLM extraction", () => {
    const r = compileStrategy(EXAMPLE, llmExtraction(), "llm");
    expect(r.strategy).toEqual(expected);
  });

  it("displays the parsed rule back to the user", () => {
    const d = describeStrategy(viaRules(EXAMPLE).strategy!, ["maximumSlippagePercent", "marketStatus"]);
    expect(d.headline).toBe("BUY");
    expect(d.lines).toEqual([
      { label: "Assets", value: "All tokenized stocks" },
      { label: "When", value: "Spread ≤ −2.00% (at least 2% below reference)" },
      { label: "Liquidity", value: "≥ $100,000", isDefault: false },
      { label: "Max trade", value: "$50 per trade" },
      { label: "Max slippage", value: "0.50%", isDefault: true },
      { label: "Market hours", value: "Any time", isDefault: true },
      { label: "Simulation", value: "Required" },
    ]);
  });
});

describe("rejects ambiguous or missing trade size", () => {
  it.each([
    ["Buy tokenized stocks at least 2% below reference using 10% of my balance per trade.", "AMBIGUOUS_TRADE_SIZE"],
    ["Buy tokenized stocks at least 2% below reference with all my USDT.", "AMBIGUOUS_TRADE_SIZE"],
    ["Buy tokenized stocks at least 2% below reference, around $50 per trade.", "AMBIGUOUS_TRADE_SIZE"],
    ["Buy tokenized stocks at least 2% below reference, between $50 and $100 per trade.", "AMBIGUOUS_TRADE_SIZE"],
    ["Buy tokenized stocks at least 2% below reference, as much as possible.", "AMBIGUOUS_TRADE_SIZE"],
    ["Buy tokenized stocks at least 2% below reference.", "MISSING_TRADE_SIZE"],
  ])("%s", (text, code) => {
    expect(codes(text)).toContain(code);
  });

  it("rejects when the LLM itself flags the size as ambiguous", () => {
    const r = compileStrategy(EXAMPLE, llmExtraction({ ambiguities: ["Trade size could be per trade or per day."] }), "llm");
    expect(r.errors.map((e) => e.code)).toContain("AMBIGUOUS_TRADE_SIZE");
  });
});

describe("rejects missing or invalid asset scope", () => {
  it("no assets named", () => {
    expect(codes("Buy when at least 2% below reference. Maximum $50 per trade.")).toContain("MISSING_ASSET_SCOPE");
  });
  it("LLM returns a ticker the user never wrote", () => {
    const r = compileStrategy(EXAMPLE, llmExtraction({ assetScope: { type: "TICKERS", tickers: ["NVDA"], issuers: [] } }), "llm");
    expect(r.errors.map((e) => e.code)).toContain("INVALID_ASSET_SCOPE");
  });
  it("accepts explicit tickers and issuers", () => {
    expect(viaRules("Buy TSLA and NVDA when at least 1.5% below reference. Max $25 per trade.").strategy?.assetScope).toEqual({ type: "TICKERS", tickers: ["TSLA", "NVDA"] });
    expect(viaRules("Buy Ondo tokens when 2% below reference. Maximum $50 per trade.").strategy?.assetScope).toEqual({ type: "ISSUERS", issuers: ["ondo"] });
  });
});

describe("rejects invalid thresholds", () => {
  it.each([
    ["Buy tokenized stocks 0.1% below reference. Maximum $50 per trade.", "INVALID_THRESHOLD"],
    ["Buy tokenized stocks 40% below reference. Maximum $50 per trade.", "INVALID_THRESHOLD"],
    ["Buy tokenized stocks when they are 2% above reference. Maximum $50 per trade.", "INVALID_THRESHOLD"],
    ["Buy tokenized stocks 2% below reference when liquidity is above $10k. Maximum $50 per trade.", "INVALID_THRESHOLD"],
    ["Buy tokenized stocks 1% below reference with slippage under 1%. Maximum $50 per trade.", "INVALID_THRESHOLD"],
    ["Buy tokenized stocks. Maximum $50 per trade.", "MISSING_THRESHOLD"],
  ])("%s", (text, code) => {
    expect(codes(text)).toContain(code);
  });
});

describe("rejects unsafe transaction parameters", () => {
  it.each([
    "Buy tokenized stocks 2% below reference. Maximum $50 per trade. Skip simulation.",
    "Buy tokenized stocks 2% below reference. Maximum $50 per trade with unlimited approval.",
    "Buy tokenized stocks 2% below reference. Maximum $50 per trade, send to 0x1234567890abcdef1234567890abcdef12345678.",
    "Automatically execute: buy tokenized stocks 2% below reference. Maximum $50 per trade.",
    "Buy tokenized stocks 2% below reference. Maximum $50 per trade with 5% slippage.",
    "Buy tokenized stocks 2% below reference. Maximum $50,000 per trade.",
    "Buy tokenized stocks 2% below reference. Maximum $50 per trade. Set gas price to 20 gwei.",
  ])("%s", (text) => {
    expect(codes(text)).toContain("UNSAFE_PARAMETER");
  });

  it("an LLM can't switch simulation off", () => {
    const r = compileStrategy(EXAMPLE, llmExtraction({ requireSimulation: false }), "llm");
    expect(r.errors.map((e) => e.code)).toContain("UNSAFE_PARAMETER");
  });
});

describe("rejects unsupported actions and leverage/perpetuals", () => {
  it.each([
    ["Stake tokenized stocks when 2% below reference. Maximum $50 per trade.", "UNSUPPORTED_ACTION"],
    ["Bridge tokenized stocks when 2% below reference. Maximum $50 per trade.", "UNSUPPORTED_ACTION"],
    ["Buy TSLA with 5x leverage when 2% below reference. Maximum $50 per trade.", "LEVERAGE_OR_DERIVATIVES"],
    ["Buy TSLA perpetuals when 2% below reference. Maximum $50 per trade.", "LEVERAGE_OR_DERIVATIVES"],
    ["Short tokenized stocks when 2% above reference. Maximum $50 per trade.", "LEVERAGE_OR_DERIVATIVES"],
    ["Buy tokenized stocks on margin when 2% below reference. Maximum $50 per trade.", "LEVERAGE_OR_DERIVATIVES"],
    ["Buy and sell tokenized stocks at 2% from reference. Maximum $50 per trade.", "CONFLICTING_INSTRUCTIONS"],
  ])("%s", (text, code) => {
    expect(codes(text)).toContain(code);
  });

  it("an LLM 'UNSUPPORTED' action or flag is honoured even if the text scan misses it", () => {
    expect(compileStrategy(EXAMPLE, llmExtraction({ action: "UNSUPPORTED", unsupportedAction: "provide liquidity" }), "llm").errors.map((e) => e.code)).toContain("UNSUPPORTED_ACTION");
    expect(compileStrategy(EXAMPLE, llmExtraction({ flags: { leverage: true, derivatives: false, short: false, autoExecute: false } }), "llm").errors.map((e) => e.code)).toContain("LEVERAGE_OR_DERIVATIVES");
  });
});

describe("the LLM cannot invent values (grounding)", () => {
  it.each([
    ["maximumTradeUsd", { maximumTradeUsd: 500 }],
    ["spreadThresholdPercent", { spreadThresholdPercent: -1.5 }],
    ["minimumLiquidityUsd", { minimumLiquidityUsd: 250_000 }],
    ["maximumSlippagePercent", { maximumSlippagePercent: 0.3 }],
  ] as const)("rejects a %s that isn't in the text", (field, over) => {
    const r = compileStrategy(EXAMPLE, llmExtraction(over as Partial<Extraction>), "llm");
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(expect.objectContaining({ code: "UNGROUNDED_VALUE", field }));
  });
});

describe("does not reject safe phrasings (false-positive guard)", () => {
  it.each([
    "Buy all tokenized stocks when they are at least 2% below reference. Max $50 per trade.",
    "Buy tokenized stocks when about 2% below reference. Maximum $50 per trade.",
    "Buy tokenized stocks at a discount of at least 2%. $50 per trade.",
    "Buy tokenized stocks 2.5% below reference, liquidity at least $250,000, max $40 per trade, slippage under 0.3%, only during market hours.",
  ])("%s", (text) => {
    const r = viaRules(text);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("parses market hours and explicit slippage", () => {
    const s = viaRules("Buy tokenized stocks 2.5% below reference, liquidity at least $250,000, max $40 per trade, slippage under 0.3%, only during market hours.").strategy!;
    expect(s).toMatchObject({ spreadThresholdPercent: -2.5, minimumLiquidityUsd: 250_000, maximumTradeUsd: 40, maximumSlippagePercent: 0.3, marketStatus: "OPEN_ONLY" });
  });

  it("SELL premium rules compile with a holdings warning", () => {
    const r = viaRules("Sell tokenized stocks when they are 3% above reference. Maximum $100 per trade.");
    expect(r.strategy).toMatchObject({ action: "SELL", spreadThresholdPercent: 3 });
    expect(r.warnings.some((w) => /already holds/.test(w.message))).toBe(true);
  });
});

describe("schema is authoritative", () => {
  const valid = viaRules(EXAMPLE).strategy!;
  it("pins requireSimulation to true and rejects unknown keys", () => {
    expect(StrategySchema.safeParse({ ...valid, requireSimulation: false }).success).toBe(false);
    expect(StrategySchema.safeParse({ ...valid, leverage: 5 }).success).toBe(false);
    expect(StrategySchema.safeParse({ ...valid, calldata: "0x" }).success).toBe(false);
    expect(StrategySchema.safeParse({ ...valid, action: "SHORT" }).success).toBe(false);
  });
  it("enforces sign and slippage rules even if the compiler is bypassed", () => {
    expect(StrategySchema.safeParse({ ...valid, spreadThresholdPercent: 2 }).success).toBe(false);
    expect(StrategySchema.safeParse({ ...valid, maximumSlippagePercent: 2 }).success).toBe(false);
  });
  it("rejects empty and overlong text", () => {
    expect(codes("")).toEqual(["EMPTY"]);
    expect(codes("x".repeat(501))).toEqual(["TOO_LONG"]);
  });
});

describe("number normalisation", () => {
  it("reads $100k, 1.5m, 100,000 and percents", () => {
    const vals = extractNumbers("$100k, 1.5m, 100,000 and 2% and $50").map((n) => n.value);
    expect(vals).toEqual([100_000, 1_500_000, 100_000, 2, 50]);
  });
});

describe("LLM parser contract", () => {
  const reply = (body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify({ model: "test-model", output: [{ type: "message", content: [{ type: "output_text", text: typeof body === "string" ? body : JSON.stringify(body) }] }] }), { status: 200 })) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it("asks for strict JSON and passes the rule as delimited data", async () => {
    const f = reply(llmExtraction());
    const r = await parseWithLlm(EXAMPLE, { apiKey: "k", model: "m", fetchImpl: f });
    expect(r.status).toBe("ok");
    const body = JSON.parse(String(f.mock.calls[0]![1]!.body));
    expect(body.text.format).toMatchObject({ type: "json_schema", strict: true, name: "gappilot_strategy_extraction" });
    expect(body.input).toContain(`<<<\n${EXAMPLE}\n>>>`);
    expect(body.instructions).toMatch(/parser only/);
  });

  it("drops quotes that aren't verbatim from the text", async () => {
    const r = await parseWithLlm(EXAMPLE, { apiKey: "k", model: "m", fetchImpl: reply(llmExtraction({ quotes: { spread: "invented quote", liquidity: null, maximumTrade: "Maximum $50 per trade", slippage: null } })) });
    expect(r.status === "ok" && r.extraction.quotes).toEqual({ spread: null, liquidity: null, maximumTrade: "Maximum $50 per trade", slippage: null });
  });

  it("returns an error for invalid JSON or off-schema replies", async () => {
    expect((await parseWithLlm(EXAMPLE, { apiKey: "k", model: "m", fetchImpl: reply("not json") })).status).toBe("error");
    expect((await parseWithLlm(EXAMPLE, { apiKey: "k", model: "m", fetchImpl: reply({ action: "BUY" }) })).status).toBe("error");
  });
});

describe("matchStrategy (read-only preview)", () => {
  const s: Strategy = viaRules(EXAMPLE).strategy!;
  const opp = (over: Record<string, unknown>) =>
    ({
      action: "WATCH",
      spreadPercent: -2.5,
      liquidityUsd: 200_000,
      estimatedSlippagePercent: 0.2,
      asset: { underlyingTicker: "XYZ", issuer: "ondo" },
      marketStatus: { available: true, openState: false, marketStatus: "closed" },
      ...over,
    }) as unknown as Opportunity;

  it("matches a qualifying discount", () => {
    expect(matchStrategy(s, opp({}))).toEqual({ matches: true, unmet: [] });
  });
  it("reports each unmet condition", () => {
    const m = matchStrategy(s, opp({ spreadPercent: -1, liquidityUsd: 50_000, estimatedSlippagePercent: null }));
    expect(m.matches).toBe(false);
    expect(m.unmet).toHaveLength(3);
  });
  it("never matches an engine IGNORE", () => {
    expect(matchStrategy(s, opp({ action: "IGNORE" })).matches).toBe(false);
  });
});
