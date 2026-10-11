/**
 * Types in this folder mirror the response/request models of Binance's official
 * generated connector `@binance-web3/wallet@13.0.1` (published 2026-10-02,
 * repo github.com/binance/binance-web3-connector-js), which is generated from
 * the Web3 API spec behind https://web3.binance.com/en/dev-docs.
 *
 * Conventions (from that source):
 *  - Every field is optional in the spec. We keep them optional and validate
 *    the fields we actually depend on at the domain boundary.
 *  - Token amounts in the smallest unit are integer STRINGS. Never parse them
 *    with Number(); use BigInt.
 *  - USD prices are decimal STRINGS.
 *  - Timestamps are Unix milliseconds (`number`).
 *  - Chain ids are strings: "56" = BSC, "1" = Ethereum, "CT_501" = Solana.
 */

/** Gateway envelope wrapped around every response. `code === 0` means success. */
export interface BinanceEnvelope<T> {
  /** Business status code. 0 indicates success. A non-zero code is an error even on HTTP 200. */
  code?: number;
  msg?: string;
  data?: T;
  /** Server response time, Unix ms. */
  timestamp?: number;
  success?: boolean;
}

/** Parsed from X-OC-* response headers (see @binance-web3/common parseRateLimitHeaders). */
export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  usedWeight?: number;
  /** Seconds, from the standard Retry-After header. */
  retryAfter?: number;
}

export interface BinanceResult<T> {
  data: T;
  rateLimit: RateLimitInfo;
  /** Server timestamp from the envelope, if present. Used for clock-skew checks. */
  serverTime?: number;
}

/** Decimal or integer encoded as a string, exactly as returned by the API. */
export type NumericString = string;
/** Integer amount in the token's smallest unit, encoded as a string. */
export type RawAmount = string;
export type UnixMs = number;
export type EvmAddress = `0x${string}`;
export type BinanceChainId = string;
