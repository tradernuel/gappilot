/**
 * determineActionability — deterministic, gate-based classification.
 *
 * Model: the candidate starts at EXECUTABLE. Each gate that fails imposes a
 * CAP ("at most WATCH"). The final action is the lowest cap. Separately,
 * data-quality issues multiply a confidence score down from 1.0.
 *
 *   IGNORE      not a signal (noise, derived reference, halted asset, honeypot)
 *   WATCH       real divergence, but costs/liquidity/pricing don't support acting
 *   ACTIONABLE  passes market-side gates; THIS wallet can't execute it (or must refresh/simulate)
 *   EXECUTABLE  passes every gate including wallet capability; still requires simulation
 *
 * Wording rule: reasons describe estimates and conditions. They never promise
 * returns, and never describe a trade as free of risk.
 */

import type { NetOpportunity, ReferenceAge, SlippageEstimate } from "./calculations";
import {
  ACTION_RANK,
  type ConfidenceLevel,
  type Direction,
  type EnginePolicy,
  type GateResult,
  type OpportunityAction,
  type QuoteInput,
  type ReferenceInput,
  type SimulationInput,
  type SpotAction,
  type WalletPosition,
} from "./types";
import type { MarketStatusView } from "../rwa/rwa-service";

export interface ActionabilityContext {
  symbol: string;
  reference: ReferenceInput;
  referenceAge: ReferenceAge | null;
  onChainAgeMs: number | null;
  market: MarketStatusView;
  spreadPercent: number;
  direction: Direction;
  spotAction: SpotAction;
  liquidityUsd: number | null;
  notional: number;
  quote: QuoteInput | null;
  quoteAgeMs: number | null;
  slippage: SlippageEstimate | null;
  net: NetOpportunity | null;
  stableDepegPercent: number | null;
  wallet: WalletPosition;
  simulation: SimulationInput | null;
  policy: EnginePolicy;
}

export interface Actionability {
  action: OpportunityAction;
  confidence: ConfidenceLevel;
  confidenceScore: number;
  referencePotentiallyStale: boolean;
  gates: GateResult[];
  reasons: string[];
}

const pct = (n: number) => `${n.toFixed(2)}%`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const mins = (ms: number) => `${Math.round(ms / 60_000)} min`;

export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.75) return "HIGH";
  if (score >= 0.5) return "MEDIUM";
  return "LOW";
}

/** "Traditional market closed" = API says not tradable, or session is explicitly closed. */
export function isTradFiClosed(m: MarketStatusView): boolean {
  return m.openState === false || m.marketStatus === "closed";
}

export function determineActionability(ctx: ActionabilityContext): Actionability {
  const { policy } = ctx;
  const gates: GateResult[] = [];
  const reasons: string[] = [];
  let ceiling: OpportunityAction = "EXECUTABLE";
  let confidence = 1;
  let referencePotentiallyStale = false;

  const cap = (gate: GateResult["gate"], to: OpportunityAction, detail: string) => {
    gates.push({ gate, passed: false, cap: to, detail });
    reasons.push(detail);
    if (ACTION_RANK[to] < ACTION_RANK[ceiling]) ceiling = to;
  };
  const pass = (gate: GateResult["gate"], detail: string) => gates.push({ gate, passed: true, detail });
  const lower = (factor: number, reason: string) => {
    confidence *= factor;
    reasons.push(reason);
  };

  const absSpread = Math.abs(ctx.spreadPercent);
  const side = ctx.direction === "PREMIUM" ? "premium" : ctx.direction === "DISCOUNT" ? "discount" : "difference";

  // ── 1. Reference independence ────────────────────────────────────────────
  if (ctx.reference.kind === "BINANCE_DERIVED") {
    cap(
      "REFERENCE",
      "IGNORE",
      "Reference is the API's referencePrice, which is derived from this token's own on-chain price; the spread is not an independent signal.",
    );
  } else {
    pass("REFERENCE", `Reference kind ${ctx.reference.kind} from ${ctx.reference.source}.`);
  }

  // ── 2. Market status ─────────────────────────────────────────────────────
  const m = ctx.market;
  if (m.isHardBlocked || m.marketStatus === "pause") {
    cap(
      "MARKET_STATUS",
      "IGNORE",
      `Asset is restricted (${m.reasonCode ?? m.marketStatus}${m.reasonMsg ? `: ${m.reasonMsg}` : ""}); corporate actions or halts can make prices non-comparable.`,
    );
  } else if (!m.available) {
    pass("MARKET_STATUS", "Market status unavailable.");
    lower(0.8, "Market status was unavailable from the API, so session context is unknown.");
  } else if (isTradFiClosed(m)) {
    pass("MARKET_STATUS", `Underlying market closed (${m.reasonMsg ?? m.reasonCode ?? m.marketStatus ?? "closed"}).`);
    const nextOpen = m.nextOpenTime ? ` Next open: ${new Date(m.nextOpenTime).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "";
    if (ctx.reference.kind === "EXTERNAL_OFFICIAL") {
      referencePotentiallyStale = true;
      lower(
        0.7,
        `The traditional market is closed, so the reference is the last official price and is potentially stale. The gap may reflect news since the close rather than a mispricing.${nextOpen}`,
      );
    } else {
      lower(
        0.85,
        `The traditional market is closed; both prices are on-chain with no live official anchor, and off-hours liquidity is typically thinner.${nextOpen}`,
      );
    }
  } else {
    pass("MARKET_STATUS", `Underlying market session: ${m.marketStatus ?? "open"}.`);
  }

  // ── 3. Spread magnitude ──────────────────────────────────────────────────
  if (absSpread * 100 < policy.minSpreadBps) {
    cap("SPREAD", "IGNORE", `Spread of ${pct(absSpread)} is within the ${policy.minSpreadBps} bps noise band.`);
  } else {
    pass("SPREAD", `Gross ${side} of ${pct(absSpread)} vs reference.`);
  }

  // ── 4. Freshness ─────────────────────────────────────────────────────────
  if (ctx.onChainAgeMs === null) {
    lower(0.8, "The on-chain price has no update timestamp, so its freshness is unknown.");
  } else if (ctx.onChainAgeMs > policy.maxPriceAgeMs) {
    cap("FRESHNESS", "ACTIONABLE", `On-chain price is ${mins(ctx.onChainAgeMs)} old (limit ${mins(policy.maxPriceAgeMs)}); refresh before acting.`);
    confidence *= 0.6;
  } else {
    pass("FRESHNESS", "On-chain price is fresh.");
  }

  const refLimit = ctx.reference.kind === "EXTERNAL_OFFICIAL" ? policy.maxOfficialReferenceAgeMs : policy.maxOnChainReferenceAgeMs;
  if (ctx.referenceAge === null) {
    lower(0.8, "The reference has no timestamp, so its age is unknown.");
  } else if (ctx.referenceAge.ageMs > refLimit) {
    if (ctx.reference.kind === "CROSS_ISSUER") {
      cap("FRESHNESS", "ACTIONABLE", `Counterpart price is ${mins(ctx.referenceAge.ageMs)} old; refresh before acting.`);
      confidence *= 0.6;
    } else {
      referencePotentiallyStale = true;
      lower(0.6, `Reference is ${ctx.referenceAge.ageHours.toFixed(1)} h old, beyond the ${(refLimit / 3_600_000).toFixed(0)} h freshness limit.`);
    }
  }
  if (ctx.referenceAge?.clockSkew) lower(0.9, "Reference timestamp is in the future (clock skew).");

  // ── 5. Liquidity ─────────────────────────────────────────────────────────
  if (ctx.liquidityUsd === null) {
    if (ctx.quote) {
      lower(0.8, "Pool liquidity is unknown; the quote is the only evidence of available depth.");
    } else {
      cap("LIQUIDITY", "WATCH", "Pool liquidity is unknown and there is no quote, so depth cannot be assessed.");
    }
  } else if (ctx.liquidityUsd < policy.minLiquidityUsd) {
    cap("LIQUIDITY", "WATCH", `Liquidity of ${usd(ctx.liquidityUsd)} is below the ${usd(policy.minLiquidityUsd)} minimum.`);
  } else if (ctx.notional > ctx.liquidityUsd * policy.maxNotionalShareOfLiquidity) {
    cap(
      "LIQUIDITY",
      "WATCH",
      `Trade size ${usd(ctx.notional)} exceeds ${(policy.maxNotionalShareOfLiquidity * 100).toFixed(0)}% of known liquidity (${usd(ctx.liquidityUsd)}).`,
    );
  } else {
    pass("LIQUIDITY", `Known liquidity ${usd(ctx.liquidityUsd)}.`);
  }
  if (ctx.liquidityUsd !== null && ctx.quote?.executionMode === "RFQ") {
    reasons.push("Execution would route via RFQ; DEX pool liquidity may not reflect RFQ depth.");
  }

  // ── 6. Quote ─────────────────────────────────────────────────────────────
  if (!ctx.quote) {
    cap(
      "QUOTE",
      "WATCH",
      ctx.wallet.connected
        ? "No executable quote for this trade, so costs can't be estimated."
        : "No executable quote: equity tokens quote via RFQ, which requires a connected wallet address.",
    );
  } else {
    if (ctx.quoteAgeMs !== null && ctx.quoteAgeMs > policy.maxQuoteAgeMs) {
      cap("QUOTE", "ACTIONABLE", `Quote is ${Math.round(ctx.quoteAgeMs / 1000)} s old (validity ≈ ${policy.maxQuoteAgeMs / 1000} s); re-quote before acting.`);
      confidence *= 0.8;
    } else {
      pass("QUOTE", `Quote from ${ctx.quote.vendorName ?? "aggregator"} (${ctx.quote.executionMode ?? "mode unknown"}).`);
    }
    if (ctx.stableDepegPercent !== null && ctx.stableDepegPercent > policy.maxStableDepegPercent) {
      lower(0.7, `Stablecoin is quoted ${pct(ctx.stableDepegPercent)} away from $1; USD figures are less reliable.`);
    }
  }

  // ── 7. Token safety ──────────────────────────────────────────────────────
  if (ctx.quote?.isHoneyPot) {
    cap("TOKEN_SAFETY", "IGNORE", "The quote flags this token as a honeypot (may not be sellable).");
  } else if (ctx.quote && (ctx.quote.taxRate ?? 0) > 0) {
    reasons.push(`Token transfer tax of ${pct((ctx.quote.taxRate ?? 0) * 100)} is included in costs.`);
  }

  // ── 8. Costs ─────────────────────────────────────────────────────────────
  if (ctx.quote && !ctx.net) {
    cap("COSTS", "WATCH", "Execution slippage could not be estimated from the quote, so no net figure is reported.");
  } else if (ctx.net) {
    const netBps = ctx.net.netPercent * 100;
    if (ctx.net.costShareOfSpread >= policy.maxCostShareOfSpread && absSpread * 100 >= policy.minSpreadBps) {
      cap(
        "COSTS",
        "WATCH",
        `Estimated costs (${pct(ctx.net.totalCostPercent)}) consume ${(Math.min(ctx.net.costShareOfSpread, 9.99) * 100).toFixed(0)}% of the ${pct(absSpread)} spread.`,
      );
    } else if (netBps < policy.minNetEdgeBps) {
      cap("COSTS", "WATCH", `Estimated net edge of ${pct(ctx.net.netPercent)} is below the ${policy.minNetEdgeBps} bps threshold.`);
    } else {
      pass("COSTS", `Estimated net edge ${pct(ctx.net.netPercent)} after ${pct(ctx.net.totalCostPercent)} estimated costs.`);
    }
    if (!ctx.net.gasIncluded) lower(0.9, "The quote did not include a network fee estimate; gas is not in the net figure.");
    if (ctx.slippage?.method === "PRICE_IMPACT") {
      lower(0.9, "Slippage is the vendor's price-impact figure, not a full quote-vs-mid comparison.");
    }
  }

  // ── 9. Wallet capability (spot only: no shorting) ────────────────────────
  const w = ctx.wallet;
  if (!w.connected) {
    cap("WALLET", "ACTIONABLE", "No wallet connected; spot executability can't be checked.");
  } else if (ctx.direction === "PREMIUM") {
    if (w.canSellNotional) {
      pass("WALLET", `Wallet holds enough ${ctx.symbol} to sell the evaluated size.`);
    } else if (!w.tokenBalance) {
      cap(
        "WALLET",
        "ACTIONABLE",
        `You hold no ${ctx.symbol}. A premium can only be acted on by selling tokens you own; spot trading cannot short it.`,
      );
    } else {
      cap("WALLET", "ACTIONABLE", `Your ${ctx.symbol} holding is smaller than the evaluated size; re-evaluate at a smaller size.`);
    }
  } else if (ctx.direction === "DISCOUNT") {
    if (w.canBuyNotional) {
      pass("WALLET", "Wallet holds enough stablecoin to buy the evaluated size.");
    } else {
      cap("WALLET", "ACTIONABLE", "Insufficient stablecoin balance to buy at the evaluated size, so the discount is not executable.");
    }
  }

  // ── 10. Simulation ───────────────────────────────────────────────────────
  if (ctx.simulation?.status === "FAILED") {
    cap("SIMULATION", "ACTIONABLE", `Simulation failed${ctx.simulation.failReason ? `: ${ctx.simulation.failReason}` : ""}.`);
  } else if (ctx.simulation?.status === "SUCCESS") {
    pass("SIMULATION", "Pre-trade simulation succeeded.");
  }

  // ── 11. Confidence floor for execution ───────────────────────────────────
  const level = confidenceLevel(confidence);
  if (level === "LOW" && ACTION_RANK[ceiling] > ACTION_RANK.ACTIONABLE) {
    ceiling = "ACTIONABLE";
    reasons.push("Confidence is LOW, so the opportunity is not marked executable.");
  }

  // ── Summary first ────────────────────────────────────────────────────────
  const summary: Record<OpportunityAction, string> = {
    IGNORE: "Not treated as an opportunity.",
    WATCH: `A ${pct(absSpread)} ${side} exists, but it does not currently clear the engine's checks.`,
    ACTIONABLE: `Market-side checks pass, but it cannot be executed from this wallet as evaluated.`,
    EXECUTABLE: `Market-side and wallet checks pass for a ${ctx.spotAction === "SELL_TOKEN" ? "sell" : "buy"}; ${
      ctx.net ? `estimated net edge ${pct(ctx.net.netPercent)}` : "costs estimated"
    }. Simulate before submitting.`,
  };
  if (ceiling === "EXECUTABLE" && ctx.simulation?.status !== "SUCCESS") {
    gates.push({ gate: "SIMULATION", passed: true, detail: "Not yet simulated; required before execution." });
  }

  return {
    action: ceiling,
    confidence: level,
    confidenceScore: Math.round(confidence * 1000) / 1000,
    referencePotentiallyStale,
    gates,
    reasons: [summary[ceiling], ...reasons],
  };
}
