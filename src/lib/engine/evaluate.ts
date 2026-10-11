import { determineActionability } from "./actionability";
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
} from "./calculations";
import {
  DEFAULT_POLICY,
  DISCLAIMER,
  type Direction,
  type EnginePolicy,
  type Opportunity,
  type OpportunityInput,
  type QuoteInput,
  type SpotAction,
  type WalletPosition,
} from "./types";

export class EngineInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineInputError";
  }
}

function walletPosition(
  input: OpportunityInput,
  tokenPriceUsd: number,
  quote: QuoteInput | null,
): WalletPosition {
  const w = input.wallet;
  if (!w) {
    return {
      connected: false,
      tokenBalance: null,
      tokenBalanceUsd: null,
      stableBalance: null,
      canSellNotional: false,
      canBuyNotional: false,
    };
  }
  const tokenBalance = rawToNumber(w.tokenBalanceRaw, w.tokenDecimals);
  const stableBalance = rawToNumber(w.stableBalanceRaw, w.stableDecimals);

  // Amount required: the quote's exact input when it matches the side, else the notional converted conservatively.
  const sellNeed =
    quote?.side === "SELL_TOKEN" && /^\d+$/.test(quote.fromAmountRaw)
      ? BigInt(quote.fromAmountRaw)
      : numberToRawCeil(input.notional / tokenPriceUsd, w.tokenDecimals);
  const buyNeed =
    quote?.side === "BUY_TOKEN" && /^\d+$/.test(quote.fromAmountRaw)
      ? BigInt(quote.fromAmountRaw)
      : numberToRawCeil(input.notional, w.stableDecimals);

  const has = (raw: string, need: bigint | null) => need !== null && /^\d+$/.test(raw) && BigInt(raw) >= need && need > 0n;

  return {
    connected: true,
    tokenBalance,
    tokenBalanceUsd: tokenBalance !== null ? tokenBalance * tokenPriceUsd : null,
    stableBalance,
    canSellNotional: has(w.tokenBalanceRaw, sellNeed),
    canBuyNotional: has(w.stableBalanceRaw, buyNeed),
  };
}

/**
 * Evaluates one tokenized equity against one reference. Deterministic:
 * identical input → identical output. Throws EngineInputError for inputs that
 * make the core numbers meaningless (non-positive prices or ratio).
 */
export function evaluateOpportunity(input: OpportunityInput): Opportunity {
  const policy: EnginePolicy = { ...DEFAULT_POLICY, ...input.policy };
  const { asset, onChain, reference, now } = input;

  const onChainPrice = perSharePrice(onChain.tokenPriceUsd, asset.tokenToShareRatio);
  if (onChainPrice === null) {
    throw new EngineInputError(`${asset.symbol}: token price and tokenToShareRatio must be positive numbers`);
  }
  const spreadUsd = calculateSpread(onChainPrice, reference.perSharePriceUsd);
  const spreadPercent = calculateSpreadPercent(onChainPrice, reference.perSharePriceUsd);
  if (spreadUsd === null || spreadPercent === null) {
    throw new EngineInputError(`${asset.symbol}: reference price must be a positive number`);
  }
  if (!(input.notional > 0)) throw new EngineInputError(`${asset.symbol}: notional must be positive`);

  const direction: Direction = spreadPercent > 0 ? "PREMIUM" : spreadPercent < 0 ? "DISCOUNT" : "NONE";
  const spotAction: SpotAction = direction === "PREMIUM" ? "SELL_TOKEN" : direction === "DISCOUNT" ? "BUY_TOKEN" : "NONE";

  // A quote only counts as evidence if it prices the trade this opportunity implies.
  const quote = input.quote && input.quote.side === spotAction && spotAction !== "NONE" ? input.quote : null;
  const ignoredQuoteReason =
    input.quote && !quote ? `Supplied quote is for ${input.quote.side}, but this opportunity implies ${spotAction}; it was not used.` : null;

  const onChainAge = calculateReferenceAge(onChain.updatedAt, now);
  const referenceAge = calculateReferenceAge(reference.asOf, now);

  const slippage = quote ? estimateSlippage(quote, onChain.tokenPriceUsd) : null;
  const taxPercent = quote?.taxRate !== null && quote?.taxRate !== undefined ? quote.taxRate * 100 : null;
  const net = slippage
    ? calculateNetOpportunity({
        grossSpreadPercent: spreadPercent,
        slippagePercent: slippage.percent,
        gasUsd: quote?.tradeFeeUsd ?? null,
        taxPercent,
        notional: input.notional,
      })
    : null;

  const stableDepegPercent =
    quote?.stableUnitPriceUsd !== null && quote?.stableUnitPriceUsd !== undefined
      ? Math.abs(quote.stableUnitPriceUsd - 1) * 100
      : null;

  const wallet = walletPosition(input, onChain.tokenPriceUsd, quote);

  const decision = determineActionability({
    symbol: asset.symbol,
    reference,
    referenceAge,
    onChainAgeMs: onChainAge?.ageMs ?? null,
    market: input.market,
    spreadPercent,
    direction,
    spotAction,
    liquidityUsd: input.liquidity?.totalUsd ?? null,
    notional: input.notional,
    quote,
    quoteAgeMs: quote ? Math.max(0, now - quote.fetchedAt) : null,
    slippage,
    net,
    stableDepegPercent,
    wallet,
    simulation: input.simulation ?? null,
    policy,
  });

  const score = calculateOpportunityScore({
    netOpportunityPercent: net?.netPercent ?? null,
    grossSpreadPercent: spreadPercent,
    liquidityUsd: input.liquidity?.totalUsd ?? null,
    confidenceScore: decision.confidenceScore,
    policy,
  });

  return {
    asset,
    evaluatedAt: now,
    notional: input.notional,
    onChainPrice,
    onChainTokenPrice: onChain.tokenPriceUsd,
    referencePrice: reference.perSharePriceUsd,
    referenceKind: reference.kind,
    referenceSource: reference.source,
    spreadUsd,
    absoluteSpreadUsd: Math.abs(spreadUsd),
    spreadPercent,
    direction,
    spotAction,
    onChainPriceAgeSeconds: onChainAge ? onChainAge.ageMs / 1000 : null,
    referenceAgeHours: referenceAge?.ageHours ?? null,
    referencePotentiallyStale: decision.referencePotentiallyStale,
    marketStatus: input.market,
    liquidityUsd: input.liquidity?.totalUsd ?? null,
    estimatedSlippagePercent: slippage?.percent ?? null,
    estimatedGasUsd: quote?.tradeFeeUsd ?? null,
    estimatedTaxPercent: taxPercent,
    totalCostPercent: net?.totalCostPercent ?? null,
    netOpportunityPercent: net?.netPercent ?? null,
    walletPosition: wallet,
    action: decision.action,
    confidence: decision.confidence,
    confidenceScore: decision.confidenceScore,
    score: decision.action === "IGNORE" ? 0 : score,
    gates: decision.gates,
    reasons: ignoredQuoteReason ? [...decision.reasons, ignoredQuoteReason] : decision.reasons,
    disclaimer: DISCLAIMER,
  };
}

/** Sorts strongest first: action, then score, then |spread|. Stable and deterministic. */
export function rankOpportunities(list: Opportunity[]): Opportunity[] {
  const rank = { EXECUTABLE: 3, ACTIONABLE: 2, WATCH: 1, IGNORE: 0 } as const;
  return [...list].sort(
    (a, b) =>
      rank[b.action] - rank[a.action] ||
      b.score - a.score ||
      Math.abs(b.spreadPercent) - Math.abs(a.spreadPercent) ||
      a.asset.address.localeCompare(b.asset.address),
  );
}
