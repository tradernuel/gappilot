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
  excludeRiskToken?: boolean | null;
  page?: number | null;
  /** 1–100, default 20. */
  pageSize?: number | null;
}
export interface TokenBalance {
  binanceChainId?: BinanceChainId | null;
  /** Empty string for the native asset. */
  tokenContractAddress?: string | null;
  address?: string | null;
  symbol?: string | null;
  /** Human-readable (decimals applied). */
  balance?: NumericString | null;
  /** Smallest units. May be empty string on some chains. */
  rawBalance?: RawAmount | null;
  tokenPrice?: NumericString | null;
  isRiskToken?: boolean | null;
}
export interface BalancePage {
  page?: number | null;
  pageSize?: number | null;
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
