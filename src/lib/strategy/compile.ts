/**
 * Deterministic strategy compiler: Extraction (untrusted) → Strategy (validated).
 *
 * It never trusts the parser. The raw text is scanned independently, every
 * numeric value must appear in the text, thresholds and caps are enforced,
 * defaults are explicit, and the result must pass StrategySchema.
 */
import { STRATEGY_LIMITS, StrategySchema, ISSUERS, type CompileResult, type Extraction, type Issue, type Strategy } from "./schema";
import { isGrounded, scanText } from "./text";

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function compileStrategy(text: string, extraction: Extraction | null, parser: CompileResult["parser"]): CompileResult {
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const defaultsApplied: CompileResult["defaultsApplied"] = [];
  const fail = (code: Issue["code"], message: string, field?: Issue["field"]) => errors.push({ code, message, field });
  const warn = (message: string, field?: Issue["field"]) => warnings.push({ code: "WARNING", message, field });
  const result = (strategy: Strategy | null): CompileResult => ({ ok: !!strategy && errors.length === 0, strategy: errors.length ? null : strategy, errors, warnings, defaultsApplied, parser, extraction });

  const t = text.trim();
  if (!t) { fail("EMPTY", "Describe a rule to parse.", "text"); return result(null); }
  if (t.length > STRATEGY_LIMITS.maxTextLength) { fail("TOO_LONG", `Keep the rule under ${STRATEGY_LIMITS.maxTextLength} characters.`, "text"); return result(null); }
  if (!extraction) { fail("PARSER_ERROR", "The rule could not be parsed. Try rephrasing it.", "text"); return result(null); }
  const x = extraction;

  // 1. Safety scan of the RAW text (independent of the parser).
  for (const f of scanText(t)) fail(f.code, f.message, "text");
  // Parser flags add to (never subtract from) the scan.
  if ((x.flags.leverage || x.flags.derivatives || x.flags.short) && !errors.some((e) => e.code === "LEVERAGE_OR_DERIVATIVES"))
    fail("LEVERAGE_OR_DERIVATIVES", "Leverage, shorting and derivatives aren't supported. GapPilot is spot only.", "text");
  if (x.flags.autoExecute && !errors.some((e) => e.message.startsWith("Automatic execution")))
    fail("UNSAFE_PARAMETER", "Automatic execution isn't available. Every trade will need your confirmation.", "text");

  // 2. Action
  if (x.action === "UNSUPPORTED") fail("UNSUPPORTED_ACTION", `"${x.unsupportedAction ?? "That action"}" isn't supported. Rules can only BUY or SELL tokenized stocks on spot.`, "action");
  else if (!x.action && !errors.some((e) => e.code === "CONFLICTING_INSTRUCTIONS")) fail("MISSING_ACTION", "Say whether the rule should buy or sell.", "action");

  // 3. Asset scope
  let assetScope: Strategy["assetScope"] | null = null;
  if (x.assetScope.type === "NONE") {
    fail("MISSING_ASSET_SCOPE", "Say which assets the rule covers, e.g. \"tokenized stocks\", \"TSLA and NVDA\", or \"Ondo tokens\".", "assetScope");
  } else if (x.assetScope.type === "ALL") {
    assetScope = { type: "ALL" };
  } else if (x.assetScope.type === "TICKERS") {
    const tickers = [...new Set(x.assetScope.tickers.map((s) => s.trim().toUpperCase()))];
    const bad = tickers.filter((tk) => !/^[A-Z][A-Z0-9.]{0,9}$/.test(tk) || !new RegExp(`\\b${tk.replace(".", "\\.")}\\b`, "i").test(t));
    if (!tickers.length || bad.length) fail("INVALID_ASSET_SCOPE", bad.length ? `Ticker${bad.length > 1 ? "s" : ""} ${bad.join(", ")} ${bad.length > 1 ? "aren't" : "isn't"} in your text.` : "No tickers were found.", "assetScope");
    else { assetScope = { type: "TICKERS", tickers }; warn("Tickers are checked against live listings when the strategy is matched, not now.", "assetScope"); }
  } else {
    const issuers = [...new Set(x.assetScope.issuers.map((i) => i.toLowerCase().replace(/s$/, "")))];
    const ok = issuers.filter((i): i is (typeof ISSUERS)[number] => (ISSUERS as readonly string[]).includes(i));
    if (!ok.length || ok.length !== issuers.length) fail("INVALID_ASSET_SCOPE", "Supported issuers are bStocks and Ondo.", "assetScope");
    else assetScope = { type: "ISSUERS", issuers: ok };
  }

  // 4. Maximum trade size (must be one explicit dollar amount)
  let maximumTradeUsd: number | null = null;
  const tradeAmbiguity = x.ambiguities.find((a) => /trade|size|amount/i.test(a));
  if (errors.some((e) => e.code === "AMBIGUOUS_TRADE_SIZE")) {
    /* already reported by the text scan */
  } else if (x.maximumTradeUsd === null) {
    fail("MISSING_TRADE_SIZE", "Set a maximum trade size in dollars, e.g. \"maximum $50 per trade\".", "maximumTradeUsd");
  } else if (tradeAmbiguity) {
    fail("AMBIGUOUS_TRADE_SIZE", `The trade size is ambiguous: ${tradeAmbiguity}`, "maximumTradeUsd");
  } else if (!isGrounded(x.maximumTradeUsd, t)) {
    fail("UNGROUNDED_VALUE", `A trade size of ${fmtUsd(x.maximumTradeUsd)} doesn't appear in your text.`, "maximumTradeUsd");
  } else if (!(x.maximumTradeUsd > 0) || x.maximumTradeUsd > STRATEGY_LIMITS.maxTradeUsd) {
    fail("UNSAFE_PARAMETER", `Maximum trade must be above $0 and at most ${fmtUsd(STRATEGY_LIMITS.maxTradeUsd)}.`, "maximumTradeUsd");
  } else {
    maximumTradeUsd = x.maximumTradeUsd;
  }

  // 5. Spread threshold
  let spread: number | null = null;
  if (x.spreadThresholdPercent === null) {
    fail("MISSING_THRESHOLD", "Set a spread, e.g. \"at least 2% below reference\".", "spreadThresholdPercent");
  } else if (!isGrounded(x.spreadThresholdPercent, t)) {
    fail("UNGROUNDED_VALUE", `A ${Math.abs(x.spreadThresholdPercent)}% threshold doesn't appear in your text.`, "spreadThresholdPercent");
  } else {
    const m = Math.abs(x.spreadThresholdPercent);
    if (m < STRATEGY_LIMITS.minSpreadPercent) fail("INVALID_THRESHOLD", `A ${m}% spread is within normal noise. Use at least ${STRATEGY_LIMITS.minSpreadPercent}%.`, "spreadThresholdPercent");
    else if (m > STRATEGY_LIMITS.maxSpreadPercent) fail("INVALID_THRESHOLD", `A ${m}% spread is beyond the ${STRATEGY_LIMITS.maxSpreadPercent}% limit; gaps that large usually mean bad data or a corporate action.`, "spreadThresholdPercent");
    else if (x.action === "BUY" && x.spreadThresholdPercent > 0) fail("INVALID_THRESHOLD", "A BUY rule must target a discount (price below reference), not a premium.", "spreadThresholdPercent");
    else if (x.action === "SELL" && x.spreadThresholdPercent < 0) fail("INVALID_THRESHOLD", "A SELL rule must target a premium (price above reference), not a discount.", "spreadThresholdPercent");
    else spread = x.spreadThresholdPercent;
  }

  // 6. Liquidity (default: engine floor)
  let minimumLiquidityUsd: number | null = null;
  if (x.minimumLiquidityUsd === null) {
    minimumLiquidityUsd = STRATEGY_LIMITS.minLiquidityUsd;
    defaultsApplied.push("minimumLiquidityUsd");
  } else if (!isGrounded(x.minimumLiquidityUsd, t)) {
    fail("UNGROUNDED_VALUE", `A liquidity minimum of ${fmtUsd(x.minimumLiquidityUsd)} doesn't appear in your text.`, "minimumLiquidityUsd");
  } else if (x.minimumLiquidityUsd < STRATEGY_LIMITS.minLiquidityUsd) {
    fail("INVALID_THRESHOLD", `Minimum liquidity can't be below the engine's ${fmtUsd(STRATEGY_LIMITS.minLiquidityUsd)} floor.`, "minimumLiquidityUsd");
  } else if (x.minimumLiquidityUsd > STRATEGY_LIMITS.maxLiquidityUsd) {
    fail("INVALID_THRESHOLD", "That liquidity minimum is unrealistically large.", "minimumLiquidityUsd");
  } else {
    minimumLiquidityUsd = x.minimumLiquidityUsd;
  }

  // 7. Slippage (default: 0.5%, or half the threshold if smaller)
  let maximumSlippagePercent: number | null = null;
  if (x.maximumSlippagePercent === null) {
    if (spread !== null) {
      maximumSlippagePercent = Math.min(STRATEGY_LIMITS.defaultSlippagePercent, Math.abs(spread) / 2);
      defaultsApplied.push("maximumSlippagePercent");
    }
  } else if (!isGrounded(x.maximumSlippagePercent, t)) {
    fail("UNGROUNDED_VALUE", `A ${x.maximumSlippagePercent}% slippage limit doesn't appear in your text.`, "maximumSlippagePercent");
  } else if (!(x.maximumSlippagePercent > 0) || x.maximumSlippagePercent > STRATEGY_LIMITS.maxSlippagePercent) {
    fail("UNSAFE_PARAMETER", `Maximum slippage must be above 0% and at most ${STRATEGY_LIMITS.maxSlippagePercent}%.`, "maximumSlippagePercent");
  } else if (spread !== null && x.maximumSlippagePercent >= Math.abs(spread)) {
    fail("INVALID_THRESHOLD", "The slippage limit must be smaller than the spread threshold, or costs could consume the whole gap.", "maximumSlippagePercent");
  } else {
    maximumSlippagePercent = x.maximumSlippagePercent;
  }

  // 8. Market status (default: any)
  const marketStatus = x.marketStatus ?? "ANY";
  if (x.marketStatus === null) defaultsApplied.push("marketStatus");

  // 9. Simulation is mandatory
  if (x.requireSimulation === false && !errors.some((e) => e.message.startsWith("Simulation is always required")))
    fail("UNSAFE_PARAMETER", "Simulation is always required and can't be turned off.", "requireSimulation");

  if (errors.length) return result(null);

  // 10. Warnings that don't block
  if (maximumTradeUsd! > minimumLiquidityUsd! * 0.02)
    warn(`A ${fmtUsd(maximumTradeUsd!)} trade exceeds 2% of the ${fmtUsd(minimumLiquidityUsd!)} liquidity floor; the engine will downgrade such trades in thin pools.`, "maximumTradeUsd");
  if (x.action === "SELL") warn("SELL rules only apply to tokens your wallet already holds; spot trading can't short.", "action");
  if (marketStatus !== "OPEN_ONLY") warn("Off-hours gaps may reflect news since the close rather than mispricing.", "marketStatus");

  // 11. Final schema validation (authoritative)
  const parsed = StrategySchema.safeParse({
    version: 1,
    action: x.action,
    assetScope,
    spreadThresholdPercent: spread,
    minimumLiquidityUsd,
    maximumTradeUsd,
    maximumSlippagePercent,
    marketStatus,
    requireSimulation: true,
    sourceText: t,
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues) fail("INVALID_THRESHOLD", `${i.path.join(".")}: ${i.message}`);
    return result(null);
  }
  return result(parsed.data);
}
