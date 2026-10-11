import type { BinanceChainId, NumericString, UnixMs } from "./common";

/**
 * Market (General Data) API —
 * https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/general-data
 */

export interface TokenParams {
  binanceChainId: BinanceChainId;
  tokenContractAddress: string;
}

// ── POST /api/v1/dex/market/token/basic-info (params in QUERY string) ────────
export interface TokenBasicInfo {
  binanceChainId?: BinanceChainId | null;
  tokenContractAddress?: string | null;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  tokenLogoUrl?: string | null;
  /** number here; string in /rwa/tokens. */
  decimals?: number | null;
  creatorAddress?: string | null;
  createTime?: UnixMs | null;
  /** Shape not needed by GapPilot; kept opaque. */
  tagList?: unknown;
}

// ── GET /api/v1/dex/market/token/top-liquidity ───────────────────────────────
export interface LiquidityPool {
  /** e.g. "PEPE/WETH" */
  pool?: string | null;
  protocolName?: string | null;
  protocolLogoUrl?: string | null;
  liquidityUsd?: NumericString | null;
  poolAddress?: string | null;
  liquidityAmount?: Array<{
    tokenAmount?: NumericString | null;
    tokenSymbol?: string | null;
    tokenName?: string | null;
    tokenContractAddress?: string | null;
    tokenLogoUrl?: string | null;
  }>;
}

// ── POST /api/v1/dex/market/price ────────────────────────────────────────────
// ⚠ INTEGRATION POINT: request body shape is undocumented in the official
// generated SDK (it sends an empty body). Response shape is documented.
export interface TokenPrice {
  binanceChainId?: BinanceChainId | null;
  tokenContractAddress?: string | null;
  price?: NumericString | null;
  time?: UnixMs | null;
}

// ── POST /api/v1/dex/market/price-info ───────────────────────────────────────
// ⚠ INTEGRATION POINT: same body problem as /market/price. Up to 100 tokens.
export interface TokenTradingInfo {
  binanceChainId?: BinanceChainId | null;
  tokenContractAddress?: string | null;
  price?: NumericString | null;
  time?: UnixMs | null;
  marketCap?: NumericString | null;
  priceChange5M?: NumericString | null;
  priceChange1H?: NumericString | null;
  priceChange4H?: NumericString | null;
  priceChange24H?: NumericString | null;
  volume5M?: NumericString | null;
  volume1H?: NumericString | null;
  volume4H?: NumericString | null;
  volume24H?: NumericString | null;
  buyVolume24H?: NumericString | null;
  sellVolume24H?: NumericString | null;
  txs24H?: number | null;
  maxPrice?: NumericString | null;
  minPrice?: NumericString | null;
  circSupply?: NumericString | null;
  /** Token liquidity in USD. */
  liquidity?: NumericString | null;
  holders?: number | null;
  /** Many more bn* (Binance MPC wallet) fields exist; omitted as unused. */
  [extra: string]: unknown;
}
