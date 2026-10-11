/**
 * Pure mappers from Binance API responses to engine inputs.
 * They never invent values: anything missing or unparseable becomes null,
 * and the engine treats null as "unknown" (lower confidence or a cap).
 */
import type { LiquidityPool, QuoteRoute, TokenBalance } from "../binance/types";
import { numberToRawCeil, rawToNumber } from "./calculations";
import type { LiquidityInput, QuoteInput, ReferenceInput, SpotAction, WalletInput } from "./types";

const num = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const int = (v: string | null | undefined): number | null => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && n >= 0 ? n : null;
};
const sameAddr = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** Sums liquidityUsd across pools. null when no pool has a usable figure. */
export function sumLiquidity(pools: LiquidityPool[] | null | undefined): LiquidityInput | null {
  if (!pools || pools.length === 0) return null;
  const values = pools.map((p) => num(p.liquidityUsd)).filter((v): v is number => v !== null && v >= 0);
  if (values.length === 0) return { totalUsd: null, poolCount: pools.length };
  return { totalUsd: values.reduce((a, b) => a + b, 0), poolCount: pools.length };
}

/** isBest route, else the route with the largest toTokenAmount (compared as BigInt). */
export function selectBestRoute(routes: QuoteRoute[] | null | undefined): QuoteRoute | null {
  if (!routes || routes.length === 0) return null;
  const best = routes.find((r) => r.isBest);
  if (best) return best;
  return routes
    .filter((r) => /^\d+$/.test(r.toTokenAmount ?? ""))
    .reduce<QuoteRoute | null>((acc, r) => (!acc || BigInt(r.toTokenAmount!) > BigInt(acc.toTokenAmount!) ? r : acc), null);
}

/**
 * QuoteRoute → QuoteInput. Decimals come from the quote's token objects, with
 * caller-supplied fallbacks. Returns null if amounts or decimals are unusable.
 */
export function quoteFromRoute(
  route: QuoteRoute,
  side: Exclude<SpotAction, "NONE">,
  fetchedAt: number,
  fallbackDecimals: { from?: number | null; to?: number | null } = {},
): QuoteInput | null {
  const fromDecimals = int(route.fromToken?.decimal) ?? fallbackDecimals.from ?? null;
  const toDecimals = int(route.toToken?.decimal) ?? fallbackDecimals.to ?? null;
  if (!/^\d+$/.test(route.fromTokenAmount ?? "") || !/^\d+$/.test(route.toTokenAmount ?? "")) return null;
  if (fromDecimals === null || toDecimals === null) return null;

  const stableToken = side === "BUY_TOKEN" ? route.fromToken : route.toToken;
  const taxes = [num(route.fromToken?.taxRate), num(route.toToken?.taxRate)].filter((t): t is number => t !== null);

  return {
    side,
    fromAmountRaw: route.fromTokenAmount!,
    fromDecimals,
    toAmountRaw: route.toTokenAmount!,
    toDecimals,
    stableUnitPriceUsd: num(stableToken?.tokenUnitPrice),
    priceImpactPercent: num(route.priceImpactPercent),
    tradeFeeUsd: num(route.tradeFee),
    taxRate: taxes.length ? Math.max(...taxes) : null,
    isHoneyPot: route.fromToken?.isHoneyPot === true || route.toToken?.isHoneyPot === true,
    executionMode: route.executionMode ?? null,
    vendorName: route.vendorName ?? null,
    quoteId: route.quoteId ?? null,
    fetchedAt,
  };
}

/** Reference = the same underlying's per-share price from another issuer's token. */
export function crossIssuerReference(counterpart: {
  address: string;
  issuer: string;
  symbol: string;
  perSharePriceUsd: number;
  updatedAt: number | null;
}): ReferenceInput {
  return {
    kind: "CROSS_ISSUER",
    perSharePriceUsd: counterpart.perSharePriceUsd,
    asOf: counterpart.updatedAt,
    source: `${counterpart.issuer}:${counterpart.symbol}`,
    counterpart: { address: counterpart.address, issuer: counterpart.issuer, symbol: counterpart.symbol },
  };
}

/** Raw balance for one token from Wallet API entries. Missing token → "0". */
export function rawBalanceOf(assets: TokenBalance[], tokenAddress: string, decimals: number): string {
  const entry = assets.find((a) => sameAddr(a.tokenContractAddress, tokenAddress));
  if (!entry) return "0";
  if (entry.rawBalance && /^\d+$/.test(entry.rawBalance)) return entry.rawBalance;
  // Spec: rawBalance may be "" on some chains; fall back to the decimal balance (floored).
  const human = num(entry.balance);
  if (human === null || human <= 0) return "0";
  const ceil = numberToRawCeil(human, decimals);
  if (ceil === null) return "0";
  // numberToRawCeil rounds up; step back down if that overshot, to stay conservative.
  const back = rawToNumber(ceil.toString(), decimals);
  return (back !== null && back > human && ceil > 0n ? ceil - 1n : ceil).toString();
}

export function walletInput(args: {
  address: string;
  assets: TokenBalance[];
  token: { address: string; decimals: number };
  stable: { address: string; decimals: number };
  fetchedAt: number;
}): WalletInput {
  return {
    address: args.address,
    tokenBalanceRaw: rawBalanceOf(args.assets, args.token.address, args.token.decimals),
    tokenDecimals: args.token.decimals,
    stableBalanceRaw: rawBalanceOf(args.assets, args.stable.address, args.stable.decimals),
    stableDecimals: args.stable.decimals,
    fetchedAt: args.fetchedAt,
  };
}
