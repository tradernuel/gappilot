/**
 * Deterministic agent policy. No I/O, no LLM. Given the same Opportunity and
 * rules, it always returns the same decision, risks, reasons and summary.
 *
 * Conservatism rules:
 *  - The agent's decision is never above the engine's action.
 *  - EXECUTABLE additionally requires every user rule to pass and no HIGH risk.
 *  - The strongest recommendation is SIMULATE. The agent never executes.
 */
import type { ConfidenceLevel, Opportunity, OpportunityAction } from "../engine/types";
import {
  CONFIDENCE_RANK,
  SEVERITY_RANK,
  type AgentDecision,
  type AgentRisk,
  type RecommendedAction,
  type RuleCheck,
  type UserRules,
} from "./types";

// ── Formatting (deterministic, locale-independent) ──────────────────────────
const pct = (n: number) => `${Math.abs(n).toFixed(2)}%`;
const usd = (n: number) => `$${n.toFixed(n >= 1000 ? 0 : 2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
const hours = (h: number) => (h >= 10 ? `${Math.round(h)} hours` : h >= 1 ? `${h.toFixed(1)} hours` : `${Math.round(h * 60)} minutes`);
const issuerName = (i: string) => (i === "bstock" ? "bStocks" : i === "ondo" ? "Ondo" : i);

export function isClosed(o: Opportunity): boolean {
  return o.marketStatus.available && (o.marketStatus.openState === false || o.marketStatus.marketStatus === "closed");
}
const failedGate = (o: Opportunity, gate: string) => o.gates.some((g) => g.gate === gate && !g.passed);

function referencePhrase(o: Opportunity): string {
  if (o.referenceKind === "EXTERNAL_OFFICIAL") return "the last reference price";
  if (o.referenceKind === "CROSS_ISSUER") {
    const [issuer, symbol] = o.referenceSource.split(":");
    return symbol ? `${symbol} on ${issuerName(issuer!)}` : "the other issuer's token";
  }
  return "its derived reference";
}

// ── User rules ───────────────────────────────────────────────────────────────
export function checkRules(o: Opportunity, rules: UserRules): RuleCheck[] {
  const checks: RuleCheck[] = [];
  const add = (rule: RuleCheck["rule"], passed: boolean, detail: string) => checks.push({ rule, passed, detail });

  add("MAX_NOTIONAL", o.notional <= rules.maxNotionalUsd,
    `Trade size ${usd(o.notional)} ${o.notional <= rules.maxNotionalUsd ? "is within" : "exceeds"} your ${usd(rules.maxNotionalUsd)} limit.`);

  if (o.netOpportunityPercent === null) add("MIN_NET_EDGE", false, "Net edge is unknown (no executable quote), so your minimum can't be confirmed.");
  else add("MIN_NET_EDGE", o.netOpportunityPercent >= rules.minNetEdgePercent,
    `Estimated net edge ${o.netOpportunityPercent < 0 ? "−" : ""}${pct(o.netOpportunityPercent)} ${o.netOpportunityPercent >= rules.minNetEdgePercent ? "meets" : "is below"} your ${pct(rules.minNetEdgePercent)} minimum.`);

  if (o.estimatedSlippagePercent === null) add("MAX_SLIPPAGE", false, "Slippage is unknown, so your slippage limit can't be confirmed.");
  else add("MAX_SLIPPAGE", o.estimatedSlippagePercent <= rules.maxSlippagePercent,
    `Estimated slippage ${pct(o.estimatedSlippagePercent)} ${o.estimatedSlippagePercent <= rules.maxSlippagePercent ? "is within" : "exceeds"} your ${pct(rules.maxSlippagePercent)} limit.`);

  if (o.referenceAgeHours === null) add("MAX_REFERENCE_AGE", false, "Reference age is unknown, so your age limit can't be confirmed.");
  else add("MAX_REFERENCE_AGE", o.referenceAgeHours <= rules.maxReferenceAgeHours,
    `Reference age ${hours(o.referenceAgeHours)} ${o.referenceAgeHours <= rules.maxReferenceAgeHours ? "is within" : "exceeds"} your ${hours(rules.maxReferenceAgeHours)} limit.`);

  add("MIN_CONFIDENCE", CONFIDENCE_RANK[o.confidence] >= CONFIDENCE_RANK[rules.minConfidence],
    `Engine confidence ${o.confidence} ${CONFIDENCE_RANK[o.confidence] >= CONFIDENCE_RANK[rules.minConfidence] ? "meets" : "is below"} your ${rules.minConfidence} minimum.`);

  if (!rules.allowMarketClosed) add("MARKET_CLOSED", !isClosed(o),
    isClosed(o) ? "The underlying market is closed and your rules exclude off-hours trades." : "The underlying market is open.");

  return checks;
}

// ── Risks ────────────────────────────────────────────────────────────────────
/** Ordered by precedence for ties: earlier = more fundamental. */
export function identifyRisks(o: Opportunity, rules: UserRules): AgentRisk[] {
  const risks: AgentRisk[] = [];
  const add = (code: AgentRisk["code"], severity: AgentRisk["severity"], text: string) => risks.push({ code, severity, text });
  const closed = isClosed(o);

  if (o.referenceKind === "BINANCE_DERIVED")
    add("DERIVED_REFERENCE", "HIGH", "The reference is derived from this token's own price, so the spread is not independent evidence of mispricing.");
  if (o.marketStatus.isHardBlocked)
    add("CORPORATE_ACTION", "HIGH", `The asset is restricted (${o.marketStatus.reasonMsg ?? o.marketStatus.reasonCode ?? "paused"}); prices may not be comparable across a corporate action.`);
  if (failedGate(o, "TOKEN_SAFETY"))
    add("TOKEN_SAFETY", "HIGH", "The quote flags the token as potentially unsellable.");

  if (o.referenceKind === "EXTERNAL_OFFICIAL") {
    const old = o.referenceAgeHours !== null && o.referenceAgeHours > rules.maxReferenceAgeHours;
    if (closed || old || o.referencePotentiallyStale) {
      add("REFERENCE_STALE", closed || old ? "HIGH" : "MEDIUM",
        o.referenceAgeHours !== null
          ? `The reference is ${hours(o.referenceAgeHours)} old, so the divergence may reflect new information rather than a pure mispricing.`
          : "The reference age is unknown, so the divergence may reflect new information rather than a pure mispricing.");
    }
  }

  if (failedGate(o, "FRESHNESS")) add("DATA_FRESHNESS", "HIGH", "Price data is older than the freshness limit; the spread may already have changed.");
  else if (o.onChainPriceAgeSeconds === null) add("DATA_FRESHNESS", "MEDIUM", "The on-chain price has no timestamp, so its freshness is unknown.");

  const gross = Math.abs(o.spreadPercent);
  if (o.totalCostPercent === null) {
    if (o.action !== "IGNORE") add("EXECUTION_COST", "MEDIUM", "Execution costs are unknown without an executable quote; they could consume the spread.");
  } else if (gross > 0) {
    const share = o.totalCostPercent / gross;
    if (share >= 0.5) add("EXECUTION_COST", "HIGH", `Estimated costs of ${pct(o.totalCostPercent)} consume most of the ${pct(gross)} spread.`);
    else if (share >= 0.25) add("EXECUTION_COST", "MEDIUM", `Estimated costs of ${pct(o.totalCostPercent)} take a meaningful share of the ${pct(gross)} spread.`);
  }

  if (failedGate(o, "LIQUIDITY")) add("LIQUIDITY", "HIGH", "Known liquidity is too thin for the evaluated size.");
  else if (o.liquidityUsd === null) add("LIQUIDITY", "MEDIUM", "Pool liquidity is unknown; depth at execution may be lower than quoted.");
  else if (o.notional > o.liquidityUsd * 0.01) add("LIQUIDITY", "MEDIUM", `The trade is a noticeable share of the ${usd(o.liquidityUsd)} known liquidity.`);

  if (closed && o.referenceKind === "CROSS_ISSUER")
    add("OFF_HOURS", "MEDIUM", "The market is closed, so nothing anchors either token to an official price; the gap may widen or close when trading resumes.");

  if ((o.estimatedTaxPercent ?? 0) > 0) add("TOKEN_TAX", "LOW", `The token charges a ${pct(o.estimatedTaxPercent!)} transfer tax.`);
  if (o.referenceKind === "CROSS_ISSUER")
    add("ISSUER_STRUCTURE", "LOW", "The two issuers' tokens differ in structure and redemption terms, so a gap between them can persist.");
  add("PRICE_MOVEMENT", "LOW", "Prices can move between the quote and execution.");

  return risks;
}

export function mainRisk(risks: AgentRisk[]): AgentRisk | null {
  return risks.reduce<AgentRisk | null>((best, r) => (!best || SEVERITY_RANK[r.severity] > SEVERITY_RANK[best.severity] ? r : best), null);
}

// ── Decision ─────────────────────────────────────────────────────────────────
export interface Decision {
  decision: AgentDecision;
  recommendedAction: RecommendedAction;
  confidence: ConfidenceLevel;
  executableUnderRules: boolean;
  /** Why the agent is stricter than the engine (empty if it agrees). */
  downgrades: string[];
}

const minConfidence = (a: ConfidenceLevel, b: ConfidenceLevel): ConfidenceLevel => (CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b);

export function decide(o: Opportunity, checks: RuleCheck[], risks: AgentRisk[]): Decision {
  const engine: OpportunityAction = o.action;
  const rulesPass = checks.every((c) => c.passed);
  const top = mainRisk(risks);
  const highRisk = top?.severity === "HIGH";
  const walletStructural = o.walletPosition.connected && failedGate(o, "WALLET");
  const simulationFailed = failedGate(o, "SIMULATION");
  const downgrades: string[] = [];

  let decision: AgentDecision;
  let action: RecommendedAction;

  switch (engine) {
    case "IGNORE":
      decision = "IGNORE";
      action = "NO_ACTION";
      break;
    case "WATCH":
      decision = "WATCH";
      action = "WAIT";
      break;
    case "ACTIONABLE":
      if (simulationFailed) {
        decision = "WATCH";
        action = "NO_ACTION";
        downgrades.push("the pre-trade simulation failed");
      } else if (walletStructural) {
        // The wallet can't take this trade; waiting doesn't change that.
        decision = "WATCH";
        action = "NO_ACTION";
        downgrades.push(o.direction === "PREMIUM" ? "spot trading cannot capture a premium without holding the token" : "the wallet can't fund the evaluated size");
      } else if (!rulesPass) {
        decision = "WATCH";
        action = "WAIT";
        downgrades.push("it fails one or more of your rules");
      } else {
        decision = "ACTIONABLE";
        action = "WAIT"; // stale data, expired quote, no wallet, or low confidence: refresh/connect first
      }
      break;
    case "EXECUTABLE":
      if (!rulesPass) {
        decision = "WATCH";
        action = "WAIT";
        downgrades.push("it fails one or more of your rules");
      } else if (highRisk) {
        decision = "ACTIONABLE";
        action = "WAIT";
        downgrades.push(`its main risk is rated HIGH (${top!.code.toLowerCase().replace(/_/g, " ")})`);
      } else {
        decision = "EXECUTABLE";
        action = "SIMULATE";
      }
      break;
  }

  let confidence = o.confidence;
  if (highRisk) confidence = minConfidence(confidence, "MEDIUM");

  return {
    decision,
    recommendedAction: action,
    confidence,
    executableUnderRules: decision === "EXECUTABLE",
    downgrades,
  };
}

// ── Reasons & summary ────────────────────────────────────────────────────────
/** Why the opportunity exists, what the engine concluded, and why the agent decided as it did. */
export function explain(o: Opportunity, d: Decision, checks: RuleCheck[]): string[] {
  const reasons: string[] = [];
  const dir = o.spreadPercent > 0 ? "above" : o.spreadPercent < 0 ? "below" : "level with";
  reasons.push(
    `${o.asset.symbol} (${issuerName(o.asset.issuer)}) trades ${pct(o.spreadPercent)} ${dir} ${referencePhrase(o)} per share (${usd(o.onChainPrice)} vs ${usd(o.referencePrice)}).`,
  );

  if (isClosed(o)) {
    reasons.push(
      o.referenceKind === "EXTERNAL_OFFICIAL"
        ? "The US market is closed, so the official reference does not update while the token keeps trading on-chain."
        : "The US market is closed; both tokens keep trading on-chain with no official price to converge to.",
    );
  } else if (!o.marketStatus.available) {
    reasons.push("Market status was not reported, so session context is unknown.");
  }

  reasons.push(`The deterministic engine classified it as ${o.action}: ${o.reasons[0] ?? "no reason given"}`);

  const w = o.walletPosition;
  if (!w.connected) reasons.push("No wallet is connected, so spot executability can't be confirmed.");
  else if (o.direction === "PREMIUM")
    reasons.push(w.canSellNotional ? `The wallet holds enough ${o.asset.symbol} to sell the evaluated size.` : `The wallet does not hold enough ${o.asset.symbol} to sell; spot trading cannot short the premium.`);
  else if (o.direction === "DISCOUNT")
    reasons.push(w.canBuyNotional ? "The wallet holds enough stablecoin to buy the evaluated size." : "The wallet lacks enough stablecoin to buy the evaluated size.");

  for (const c of checks.filter((c) => !c.passed)) reasons.push(`Fails your rule: ${c.detail}`);
  if (d.downgrades.length) reasons.push(`The agent is more conservative than the engine because ${d.downgrades.join(" and ")}.`);
  if (d.recommendedAction === "SIMULATE") reasons.push("Recommended next step is a simulation only; nothing is executed automatically.");
  return reasons;
}

/** Three plain sentences: the gap, the main risk, and whether this wallet can act. */
export function summarize(o: Opportunity, d: Decision, top: AgentRisk | null, checks: RuleCheck[]): string {
  const closed = isClosed(o);
  const dir = o.spreadPercent > 0 ? "above" : o.spreadPercent < 0 ? "below" : "level with";
  const ticker = o.asset.underlyingTicker || o.asset.symbol;
  const parts: string[] = [];

  parts.push(`${ticker} is trading ${pct(o.spreadPercent)} ${dir} ${referencePhrase(o)}${closed ? " while the US market is closed" : ""}.`);

  if (top && top.code !== "PRICE_MOVEMENT") {
    // Sentence 1 already states the market is closed; don't repeat it.
    parts.push(
      top.code === "OFF_HOURS" && closed
        ? "Nothing anchors either token to an official price, so the gap may widen or close when trading resumes."
        : top.text,
    );
  }

  const w = o.walletPosition;
  const failed = checks.filter((c) => !c.passed);
  if (o.action === "IGNORE") {
    parts.push("The engine does not treat it as an opportunity, so no action is suggested.");
  } else if (w.connected && o.direction === "PREMIUM" && !w.canSellNotional) {
    parts.push(
      w.tokenBalance
        ? `Because the wallet holds less ${o.asset.symbol} than the evaluated size, spot execution cannot capture the full premium.`
        : `Because the wallet does not hold ${o.asset.symbol}, spot execution cannot directly capture the premium.`,
    );
  } else if (w.connected && o.direction === "DISCOUNT" && !w.canBuyNotional) {
    parts.push("Because the wallet lacks enough stablecoin for the evaluated size, the discount cannot be bought as evaluated.");
  } else if (!w.connected && o.action !== "WATCH") {
    parts.push("No wallet is connected, so whether it can be executed is not yet known.");
  } else if (d.decision === "EXECUTABLE") {
    parts.push("It meets your rules and the wallet can take the trade, so the next step is a simulation; outcomes remain uncertain.");
  } else if (failed.length) {
    parts.push(`It does not meet your rules yet: ${failed[0]!.detail.charAt(0).toLowerCase()}${failed[0]!.detail.slice(1)}`);
  } else if (o.action === "WATCH") {
    parts.push("It does not clear the engine's checks, so the agent suggests waiting.");
  }
  return parts.join(" ");
}
