/**
 * Read-only preview: would a saved strategy have flagged this opportunity for
 * review? Pure and deterministic. It places no orders and builds nothing.
 */
import type { Opportunity } from "../engine/types";
import type { Strategy } from "./schema";

export interface StrategyMatch {
  matches: boolean;
  /** Plain-language reasons it doesn't match (empty when it does). */
  unmet: string[];
}

export function matchStrategy(s: Strategy, o: Opportunity): StrategyMatch {
  const unmet: string[] = [];
  const scope = s.assetScope;
  if (scope.type === "TICKERS" && !scope.tickers.includes(o.asset.underlyingTicker.toUpperCase())) unmet.push("not in the rule's tickers");
  if (scope.type === "ISSUERS" && !(scope.issuers as string[]).includes(o.asset.issuer)) unmet.push("issuer not covered");

  if (o.action === "IGNORE") unmet.push("the engine ignores it");
  if (s.action === "BUY" && !(o.spreadPercent <= s.spreadThresholdPercent)) unmet.push(`discount is ${o.spreadPercent < 0 ? Math.abs(o.spreadPercent).toFixed(2) : "0.00"}%, needs ≥ ${Math.abs(s.spreadThresholdPercent)}%`);
  if (s.action === "SELL" && !(o.spreadPercent >= s.spreadThresholdPercent)) unmet.push(`premium is ${o.spreadPercent > 0 ? o.spreadPercent.toFixed(2) : "0.00"}%, needs ≥ ${s.spreadThresholdPercent}%`);
  if (o.liquidityUsd === null) unmet.push("liquidity unknown");
  else if (o.liquidityUsd < s.minimumLiquidityUsd) unmet.push("liquidity below the rule's minimum");
  if (o.estimatedSlippagePercent === null) unmet.push("slippage unknown (needs a quote)");
  else if (o.estimatedSlippagePercent > s.maximumSlippagePercent) unmet.push("slippage above the rule's limit");

  const closed = o.marketStatus.available && (o.marketStatus.openState === false || o.marketStatus.marketStatus === "closed");
  if (s.marketStatus === "OPEN_ONLY" && (!o.marketStatus.available || closed)) unmet.push("market not open");
  if (s.marketStatus === "CLOSED_ONLY" && (!o.marketStatus.available || !closed)) unmet.push("market not closed");

  return { matches: unmet.length === 0, unmet };
}
