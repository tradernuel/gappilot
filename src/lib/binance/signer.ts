import { createHmac } from "node:crypto";

/**
 * Binance Web3 API request signing (HMAC-SHA256 variant).
 *
 * Mirrors @binance-web3/common@1.1.2 `getWeb3Signature`:
 *   prehash   = timestamp + METHOD + requestPath + body   (no separators)
 *   signature = base64( HMAC_SHA256(apiSecret, prehash) )
 *
 * `requestPath` is the path AS SENT ON THE WIRE, including the base URL's path
 * prefix ("/build") and the raw query string, e.g.
 *   /build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xa%2C0xb
 *
 * `timestamp` is ISO-8601 (new Date().toISOString()) and must equal the
 * X-OC-TIMESTAMP header byte-for-byte.
 */
export function buildPrehash(
  timestamp: string,
  method: string,
  requestPath: string,
  body: string,
): string {
  return timestamp + method.toUpperCase() + requestPath + body;
}

export function signRequest(
  apiSecret: string,
  timestamp: string,
  method: string,
  requestPath: string,
  body: string,
): string {
  return createHmac("sha256", apiSecret)
    .update(buildPrehash(timestamp, method, requestPath, body), "utf8")
    .digest("base64");
}

/** Builds the absolute URL and the exact path string to sign. */
export function buildRequestTarget(
  baseUrl: string,
  path: string,
  query: Record<string, string | number | boolean | undefined | null>,
): { url: string; requestPath: string } {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, ""); // "/build"
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  const qs = search.toString();
  const requestPath = `${basePath}${path}${qs ? `?${qs}` : ""}`;
  return { url: `${base.origin}${requestPath}`, requestPath };
}
