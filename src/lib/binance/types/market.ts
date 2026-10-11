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
  binanceChainId?: BinanceChainId;
  tokenContractAddress?: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenLogoUrl?: string | null;
  /** number here; string in /rwa/tokens. */
  decimals?: number;
  creatorAddress?: string;
  createTime?: UnixMs;
  /** Shape not needed by GapPilot; kept opaque. */
  tagList?: unknown;
}

// ── GET /api/v1/dex/market/token/top-liquidity ───────────────────────────────
export interface LiquidityPool {
  /** e.g. "PEPE/WETH" */
  pool?: string;
  protocolName?: string | null;
  protocolLogoUrl?: string | null;
  liquidityUsd?: NumericString;
  poolAddress?: string;
  liquidityAmount?: Array<{
    tokenAmount?: NumericString;
    tokenSymbol?: string;
    tokenName?: string;
    tokenContractAddress?: string;
    tokenLogoUrl?: string | null;
  }>;
}

// ── POST /api/v1/dex/market/price ────────────────────────────────────────────
// ⚠ INTEGRATION POINT: request body shape is undocumented in the official
// generated SDK (it sends an empty body). Response shape is documented.
export interface TokenPrice {
  binanceChainId?: BinanceChainId;
  tokenContractAddress?: string;
  price?: NumericString;
  time?: UnixMs;
}

// ── POST /api/v1/dex/market/price-info ───────────────────────────────────────
// ⚠ INTEGRATION POINT: same body problem as /market/price. Up to 100 tokens.
export interface TokenTradingInfo {
  binanceChainId?: BinanceChainId;
  tokenContractAddress?: string;
  price?: NumericString;
  time?: UnixMs;
  marketCap?: NumericString;
  priceChange5M?: NumericString;
  priceChange1H?: NumericString;
  priceChange4H?: NumericString;
  priceChange24H?: NumericString;
  volume5M?: NumericString;
  volume1H?: NumericString;
  volume4H?: NumericString;
  volume24H?: NumericString;
  buyVolume24H?: NumericString;
  sellVolume24H?: NumericString;
  txs24H?: number;
  maxPrice?: NumericString;
  minPrice?: NumericString;
  circSupply?: NumericString;
  /** Token liquidity in USD. */
  liquidity?: NumericString;
  holders?: number;
  /** Many more bn* (Binance MPC wallet) fields exist; omitted as unused. */
  [extra: string]: unknown;
}
