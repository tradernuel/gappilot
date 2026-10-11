import type { Opportunity } from "../engine/types";

/**
 * The ONLY data the explanation model receives: a whitelisted, rounded view of
 * one engine Opportunity. Numbers are rounded here so the model sees exactly
 * the figures the output validator will check against.
 */
export interface AssessmentFacts {
  asset: { symbol: string; issuer: string; underlyingTicker: string };
  comparedWith: { kind: string; source: string };
  notionalUsd: number;
  onChainPricePerShareUsd: number;
  referencePricePerShareUsd: number;
  spreadPercent: number;
  absoluteSpreadUsdPerShare: number;
  direction: string;
  impliedSpotAction: string;
  onChainPriceAgeSeconds: number | null;
  referenceAgeHours: number | null;
  referencePotentiallyStale: boolean;
  market: {
    statusAvailable: boolean;
    open: boolean | null;
    session: string | null;
    reasonCode: string | null;
    reason: string | null;
    nextOpenUtc: string | null;
  };
  liquidityUsd: number | null;
  estimatedSlippagePercent: number | null;
  estimatedGasUsd: number | null;
  estimatedTaxPercent: number | null;
  totalCostPercent: number | null;
  netOpportunityPercent: number | null;
  wallet: {
    connected: boolean;
    tokenBalance: number | null;
    tokenBalanceUsd: number | null;
    stableBalance: number | null;
    canSellEvaluatedSize: boolean;
    canBuyEvaluatedSize: boolean;
  };
  classification: string;
  confidence: string;
  score: number;
  checks: Array<{ check: string; passed: boolean }>;
  engineReasons: string[];
}

const r = (n: number | null | undefined, dp: number): number | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(dp));

export function buildAssessmentFacts(o: Opportunity): AssessmentFacts {
  return {
    asset: { symbol: o.asset.symbol, issuer: o.asset.issuer, underlyingTicker: o.asset.underlyingTicker },
    comparedWith: { kind: o.referenceKind, source: o.referenceSource },
    notionalUsd: r(o.notional, 2)!,
    onChainPricePerShareUsd: r(o.onChainPrice, 4)!,
    referencePricePerShareUsd: r(o.referencePrice, 4)!,
    spreadPercent: r(o.spreadPercent, 3)!,
    absoluteSpreadUsdPerShare: r(o.absoluteSpreadUsd, 4)!,
    direction: o.direction,
    impliedSpotAction: o.spotAction,
    onChainPriceAgeSeconds: r(o.onChainPriceAgeSeconds, 0),
    referenceAgeHours: r(o.referenceAgeHours, 2),
    referencePotentiallyStale: o.referencePotentiallyStale,
    market: {
      statusAvailable: o.marketStatus.available,
      open: o.marketStatus.openState,
      session: o.marketStatus.marketStatus,
      reasonCode: o.marketStatus.reasonCode,
      reason: o.marketStatus.reasonMsg,
      nextOpenUtc: o.marketStatus.nextOpenTime ? new Date(o.marketStatus.nextOpenTime).toISOString() : null,
    },
    liquidityUsd: r(o.liquidityUsd, 0),
    estimatedSlippagePercent: r(o.estimatedSlippagePercent, 3),
    estimatedGasUsd: r(o.estimatedGasUsd, 4),
    estimatedTaxPercent: r(o.estimatedTaxPercent, 3),
    totalCostPercent: r(o.totalCostPercent, 3),
    netOpportunityPercent: r(o.netOpportunityPercent, 3),
    wallet: {
      connected: o.walletPosition.connected,
      tokenBalance: r(o.walletPosition.tokenBalance, 6),
      tokenBalanceUsd: r(o.walletPosition.tokenBalanceUsd, 2),
      stableBalance: r(o.walletPosition.stableBalance, 2),
      canSellEvaluatedSize: o.walletPosition.canSellNotional,
      canBuyEvaluatedSize: o.walletPosition.canBuyNotional,
    },
    classification: o.action,
    confidence: o.confidence,
    score: o.score,
    checks: o.gates.map((g) => ({ check: g.gate, passed: g.passed })),
    engineReasons: o.reasons,
  };
}
