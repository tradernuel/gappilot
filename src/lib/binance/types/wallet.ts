import type { BinanceChainId, NumericString, RawAmount } from "./common";

/**
 * Wallet (Balance) API — read-only balance lookups for any address.
 * Note: this is NOT the Agentic Wallet. These endpoints read balances; they hold no keys.
 */

// ── GET /api/v1/dex/balance/all-token-balances-by-address ────────────────────
export interface GetAllBalancesParams {
  address: string;
  /** Spec: only ONE chain id is currently supported. */
  chains: BinanceChainId;
  excludeRiskToken?: boolean;
  page?: number;
  /** 1–100, default 20. */
  pageSize?: number;
}
export interface TokenBalance {
  binanceChainId?: BinanceChainId;
  /** Empty string for the native asset. */
  tokenContractAddress?: string;
  address?: string;
  symbol?: string;
  /** Human-readable (decimals applied). */
  balance?: NumericString;
  /** Smallest units. May be empty string on some chains. */
  rawBalance?: RawAmount;
  tokenPrice?: NumericString;
  isRiskToken?: boolean;
}
export interface BalancePage {
  page?: number;
  pageSize?: number;
  tokenAssets?: TokenBalance[];
}
/** Returned as an array (one entry per chain). */
export type AllBalancesResponse = BalancePage[];

// ── POST /api/v1/dex/balance/token-balances-by-address ───────────────────────
export interface GetTokenBalancesParams {
  address: string;
  /** Up to 20 entries. Empty tokenContractAddress = native asset. */
  tokenContractAddresses: Array<{ binanceChainId: BinanceChainId; tokenContractAddress: string }>;
  /** "0" = exclude (default), "1" = include. */
  excludeRiskToken?: "0" | "1";
}
export type TokenBalancesResponse = Array<{ tokenAssets?: TokenBalance[] }>;
