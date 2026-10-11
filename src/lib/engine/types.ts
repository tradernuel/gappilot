/**
 * GapPilot Opportunity Engine — types.
 *
 * Everything the engine needs arrives as plain data in OpportunityInput.
 * The engine does no I/O, no randomness, no LLM calls: the same input always
 * produces the same Opportunity (the clock is an input too).
 *
 * Units:
 *   - Prices are USD PER SHARE unless the name says "token". Issuers wrap
 *     different share amounts per token (tokenToShareRatio), so only per-share
 *     prices are comparable.
 *   - Percentages are plain percent: 1.5 means 1.5%.
 *   - `notional` is denominated in quote-token (stablecoin) units. It is treated
 *     as USD only after the stablecoin's quoted USD price is checked for a depeg.
 */

import type { MarketStatusView } from "../rwa/rwa-service";

export type OpportunityAction = "IGNORE" | "WATCH" | "ACTIONABLE" | "EXECUTABLE";

/** Ordered weakest → strongest; used to apply "at most X" caps. */
export const ACTION_RANK: Record<OpportunityAction, number> = {
  IGNORE: 0,
  WATCH: 1,
  ACTIONABLE: 2,
  EXECUTABLE: 3,
};

export type ConfidenceLevel = "LOW" | "MEDIUM" | "HIGH";

/**
 * PREMIUM: token trades ABOVE reference → the spot action is SELL (only possible if held).
 * DISCOUNT: token trades BELOW reference → the spot action is BUY (needs stablecoin).
 */
export type Direction = "PREMIUM" | "DISCOUNT" | "NONE";
export type SpotAction = "SELL_TOKEN" | "BUY_TOKEN" | "NONE";

/**
 * Where the reference price came from. This matters more than any number:
 *  - CROSS_ISSUER:      the same underlying's per-share price from ANOTHER issuer's token (on-chain, independent).
 *  - EXTERNAL_OFFICIAL: an official TradFi quote (e.g. last close) from a ReferencePriceProvider.
 *  - BINANCE_DERIVED:   the RWA API's `referencePrice`, which the spec says is derived
 *                       from the token's own price. Never an independent signal.
 */
export type ReferenceKind = "CROSS_ISSUER" | "EXTERNAL_OFFICIAL" | "BINANCE_DERIVED";

export interface AssetRef {
  address: string;
  issuer: string;
  symbol: string;
  underlyingTicker: string;
  decimals: number;
  /** 1 token ≈ ratio shares. */
  tokenToShareRatio: number;
}

export interface OnChainPriceInput {
  /** USD per TOKEN from /rwa/price. */
  tokenPriceUsd: number;
  /** tokenPriceUpdatedAt (Unix ms), if provided by the API. */
  updatedAt: number | null;
}

export interface ReferenceInput {
  kind: ReferenceKind;
  /** USD per SHARE. */
  perSharePriceUsd: number;
  /** When the reference was last observed (Unix ms). For TradFi: the quote/close time. */
  asOf: number | null;
  /** Human-readable source label for UI/audit, e.g. "bstock:XYZB" or "provider:none". */
  source: string;
  /** For CROSS_ISSUER: the other token. */
  counterpart?: { address: string; issuer: string; symbol: string };
}

export interface LiquidityInput {
  /** Summed USD liquidity across known pools; null when the API returned nothing usable. */
  totalUsd: number | null;
  poolCount: number;
}

/**
 * Execution evidence from a real /aggregator/quote for the trade this
 * opportunity implies, at `notional` size. Raw amounts are smallest-unit strings.
 */
export interface QuoteInput {
  side: SpotAction; // which trade was quoted
  fromAmountRaw: string;
  fromDecimals: number;
  toAmountRaw: string;
  toDecimals: number;
  /** Stablecoin USD unit price reported by the quote (fromToken on BUY, toToken on SELL). */
  stableUnitPriceUsd: number | null;
  priceImpactPercent: number | null;
  /** Estimated network fee in USD from the quote. Null if the vendor didn't return one. */
  tradeFeeUsd: number | null;
  /** 0–1 token tax reported by the quote (max of both legs). */
  taxRate: number | null;
  isHoneyPot: boolean;
  executionMode: string | null;
  vendorName: string | null;
  quoteId: string | null;
  fetchedAt: number;
}

export interface WalletInput {
  address: string;
  /** Raw smallest-unit balances. */
  tokenBalanceRaw: string;
  tokenDecimals: number;
  stableBalanceRaw: string;
  stableDecimals: number;
  fetchedAt: number;
}

export interface SimulationInput {
  status: "SUCCESS" | "FAILED" | "NOT_RUN";
  failReason?: string | null;
}

export interface EnginePolicy {
  /** Below this |spread| the difference is noise. Default 25 bps. */
  minSpreadBps: number;
  /** Net edge (after costs) required for ACTIONABLE+. Default 50 bps. */
  minNetEdgeBps: number;
  /** On-chain price older than this is stale. Default 120 s. */
  maxPriceAgeMs: number;
  /** Reference older than this lowers confidence. Default 2 min for on-chain refs; 72 h for TradFi refs. */
  maxOnChainReferenceAgeMs: number;
  maxOfficialReferenceAgeMs: number;
  /** Absolute floor on pool liquidity. Default $25k. */
  minLiquidityUsd: number;
  /** Trade notional may use at most this share of known liquidity. Default 2%. */
  maxNotionalShareOfLiquidity: number;
  /** If slippage+costs consume at least this share of the gross spread → downgrade. Default 0.5. */
  maxCostShareOfSpread: number;
  /** Quote validity window. Spec: quoteId TTL ≈ 30 s. */
  maxQuoteAgeMs: number;
  /** Stablecoin |price − 1| above this is treated as a depeg warning. Default 0.5%. */
  maxStableDepegPercent: number;
}

export const DEFAULT_POLICY: EnginePolicy = {
  minSpreadBps: 25,
  minNetEdgeBps: 50,
  maxPriceAgeMs: 120_000,
  maxOnChainReferenceAgeMs: 120_000,
  maxOfficialReferenceAgeMs: 72 * 3_600_000,
  minLiquidityUsd: 25_000,
  maxNotionalShareOfLiquidity: 0.02,
  maxCostShareOfSpread: 0.5,
  maxQuoteAgeMs: 30_000,
  maxStableDepegPercent: 0.5,
};

export interface OpportunityInput {
  asset: AssetRef;
  onChain: OnChainPriceInput;
  reference: ReferenceInput;
  market: MarketStatusView;
  liquidity: LiquidityInput | null;
  /** Size being evaluated, in quote-token units (≈ USD). */
  notional: number;
  quote?: QuoteInput | null;
  /** null/undefined = no wallet connected. */
  wallet?: WalletInput | null;
  simulation?: SimulationInput | null;
  now: number;
  policy?: Partial<EnginePolicy>;
}

export interface WalletPosition {
  connected: boolean;
  tokenBalance: number | null;
  tokenBalanceUsd: number | null;
  stableBalance: number | null;
  /** True only if the wallet holds enough token to SELL the evaluated notional. */
  canSellNotional: boolean;
  /** True only if the wallet holds enough stablecoin to BUY the evaluated notional. */
  canBuyNotional: boolean;
}

export interface GateResult {
  gate:
    | "DATA"
    | "REFERENCE"
    | "MARKET_STATUS"
    | "SPREAD"
    | "FRESHNESS"
    | "LIQUIDITY"
    | "COSTS"
    | "TOKEN_SAFETY"
    | "QUOTE"
    | "WALLET"
    | "SIMULATION";
  passed: boolean;
  /** Highest action allowed by this gate (when it fails). */
  cap?: OpportunityAction;
  detail: string;
}

export interface Opportunity {
  asset: AssetRef;
  evaluatedAt: number;
  notional: number;

  /** USD per share (token price ÷ tokenToShareRatio). */
  onChainPrice: number;
  onChainTokenPrice: number;
  referencePrice: number;
  referenceKind: ReferenceKind;
  referenceSource: string;
  /** onChainPrice − referencePrice, USD per share (signed). */
  spreadUsd: number;
  /** |spreadUsd| — the "absolute difference". */
  absoluteSpreadUsd: number;
  /** Signed, relative to the reference. Positive = premium. */
  spreadPercent: number;
  direction: Direction;
  spotAction: SpotAction;

  onChainPriceAgeSeconds: number | null;
  referenceAgeHours: number | null;
  /** Explicitly true when the TradFi market is closed and the reference is a TradFi quote. */
  referencePotentiallyStale: boolean;

  marketStatus: MarketStatusView;
  liquidityUsd: number | null;

  estimatedSlippagePercent: number | null;
  estimatedGasUsd: number | null;
  estimatedTaxPercent: number | null;
  /** slippage + gas + tax as % of notional; null if slippage unknown. */
  totalCostPercent: number | null;
  /** |spreadPercent| − totalCostPercent; null when costs can't be estimated. */
  netOpportunityPercent: number | null;

  walletPosition: WalletPosition;

  action: OpportunityAction;
  confidence: ConfidenceLevel;
  confidenceScore: number; // 0–1
  score: number; // 0–100
  gates: GateResult[];
  reasons: string[];
  /** Fixed wording; the engine never asserts profit. */
  disclaimer: string;
}

export const DISCLAIMER =
  "Estimates only. Prices, liquidity and execution costs can change before or during execution; outcomes are uncertain and losses are possible. Not financial advice.";
