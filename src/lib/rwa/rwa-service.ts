import type { BinanceWeb3Client } from "../binance/facade";
import { BinanceApiError } from "../binance/errors";
import type { RwaPrice, RwaStatusInfo, RwaToken, RwaUnderlyingMarket, RwaUnderlyingProfile } from "../binance/types";

/**
 * Higher-level RWA reads built on the typed client:
 *   - discoverAssets      → which tokenized stocks exist on BSC, grouped by ticker
 *   - getAssetInfo        → profile + market data + status + price for one token
 *   - priceRelationship   → on-chain token price vs the API's referencePrice
 *   - marketStatus        → normalised session status, "where available"
 *
 * Nothing here invents values: missing or unparseable fields become null, and
 * partial upstream failures are reported in `errors`, not papered over.
 */

export const BSC = "56";
export const ISSUERS = ["bstock", "ondo"] as const;
export type SupportedIssuer = (typeof ISSUERS)[number];

/** Reasons that must stop any trading decision outright. */
const HARD_BLOCK_REASONS = new Set(["ASSET_PAUSED", "MARKET_PAUSED", "MARKET_MAINTENANCE", "UNSUPPORTED"]);

export interface PartialError {
  source: string;
  kind: string;
  message: string;
  code?: number;
}

/** Positive finite decimal from an API string, else null. */
export function toPositiveNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Market status ────────────────────────────────────────────────────────────
export interface MarketStatusView {
  /** False when the API returned no statusInfo for this token. */
  available: boolean;
  openState: boolean | null;
  marketStatus: string | null;
  reasonCode: string | null;
  reasonMsg: string | null;
  nextOpenTime: number | null;
  nextCloseTime: number | null;
  /** Corporate action, halt, maintenance or unsupported: never trade. */
  isHardBlocked: boolean;
}

export function toMarketStatus(info: RwaStatusInfo | undefined | null): MarketStatusView {
  if (!info) {
    return {
      available: false,
      openState: null,
      marketStatus: null,
      reasonCode: null,
      reasonMsg: null,
      nextOpenTime: null,
      nextCloseTime: null,
      isHardBlocked: false,
    };
  }
  const reasonCode = info.reasonCode ?? null;
  return {
    available: true,
    openState: info.openState ?? null,
    marketStatus: info.marketStatus ?? null,
    reasonCode,
    reasonMsg: info.reasonMsg ?? null,
    nextOpenTime: info.nextOpenTime ?? null,
    nextCloseTime: info.nextCloseTime ?? null,
    isHardBlocked: reasonCode !== null && HARD_BLOCK_REASONS.has(reasonCode),
  };
}

// ── Price relationship ───────────────────────────────────────────────────────
export interface PriceRelationship {
  tokenPriceUsd: number | null;
  /** As returned by the API. Spec: DERIVED from the on-chain token price. */
  referencePriceUsd: number | null;
  /** From /rwa/tokens or /rwa/underlying-profile: 1 token ≈ ratio shares. */
  tokenToShareRatio: number | null;
  /** tokenPrice / referencePrice. If referencePrice is derived as documented, ≈ tokenToShareRatio. */
  impliedRatio: number | null;
  /** (impliedRatio − tokenToShareRatio) / tokenToShareRatio, in basis points. */
  ratioDeviationBps: number | null;
  /** tokenPrice / tokenToShareRatio: the per-share price GapPilot compares across issuers. */
  perSharePriceUsd: number | null;
  tokenPriceUpdatedAt: number | null;
  priceAgeMs: number | null;
  /** Always true: documents that referencePrice is not an independent TradFi quote. */
  referenceIsDerivedFromToken: true;
}

export function priceRelationship(
  price: Pick<RwaPrice, "tokenPrice" | "referencePrice" | "tokenPriceUpdatedAt"> | null | undefined,
  tokenToShareRatio: string | null | undefined,
  now: number = Date.now(),
): PriceRelationship {
  const tokenPriceUsd = toPositiveNumber(price?.tokenPrice);
  const referencePriceUsd = toPositiveNumber(price?.referencePrice);
  const ratio = toPositiveNumber(tokenToShareRatio);
  const impliedRatio = tokenPriceUsd !== null && referencePriceUsd !== null ? tokenPriceUsd / referencePriceUsd : null;
  const ratioDeviationBps =
    impliedRatio !== null && ratio !== null ? ((impliedRatio - ratio) / ratio) * 10_000 : null;
  const updatedAt = typeof price?.tokenPriceUpdatedAt === "number" ? price.tokenPriceUpdatedAt : null;
  return {
    tokenPriceUsd,
    referencePriceUsd,
    tokenToShareRatio: ratio,
    impliedRatio,
    ratioDeviationBps,
    perSharePriceUsd: tokenPriceUsd !== null && ratio !== null ? tokenPriceUsd / ratio : null,
    tokenPriceUpdatedAt: updatedAt,
    priceAgeMs: updatedAt !== null ? Math.max(0, now - updatedAt) : null,
    referenceIsDerivedFromToken: true,
  };
}

// ── Discovery ────────────────────────────────────────────────────────────────
export interface DiscoveredAsset {
  issuer: string;
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  assetType: number | null;
  underlyingTicker: string | null;
  underlyingName: string | null;
  tokenToShareRatio: string | null;
  tokenPrice: string | null;
  referencePrice: string | null;
  volume24H: string | null;
  status: MarketStatusView;
}

export interface DiscoveryResult {
  chainId: typeof BSC;
  fetchedAt: number;
  assets: DiscoveredAsset[];
  /** Tickers with ≥ 2 issuers on BSC — the cross-issuer candidates. */
  crossIssuerTickers: Array<{ ticker: string; issuers: string[]; addresses: string[] }>;
  /** Tokens dropped because they lacked an address. */
  skipped: number;
  errors: PartialError[];
}

function toError(source: string, err: unknown): PartialError {
  if (err instanceof BinanceApiError) return { source, kind: err.kind, message: err.message, code: err.code };
  return { source, kind: "unknown", message: err instanceof Error ? err.message : String(err) };
}

function normaliseToken(t: RwaToken, fallbackIssuer: string): DiscoveredAsset | null {
  if (!t.tokenContractAddress) return null;
  const decimals = t.decimals != null ? Number.parseInt(t.decimals, 10) : NaN;
  return {
    issuer: t.platformId ?? fallbackIssuer,
    address: t.tokenContractAddress,
    symbol: t.tokenSymbol ?? null,
    name: t.tokenName ?? null,
    decimals: Number.isInteger(decimals) ? decimals : null,
    assetType: typeof t.assetType === "number" ? t.assetType : null,
    underlyingTicker: t.underlyingTicker ?? null,
    underlyingName: t.underlyingName ?? null,
    tokenToShareRatio: t.tokenToShareRatio ?? null,
    tokenPrice: t.tokenPrice ?? null,
    referencePrice: t.referencePrice ?? null,
    volume24H: t.volume24H ?? null,
    status: toMarketStatus(t.statusInfo),
  };
}

export class RwaService {
  constructor(
    private readonly client: BinanceWeb3Client,
    private readonly now: () => number = Date.now,
  ) {}

  /** Lists tokenized stocks on BSC for each issuer and groups them by ticker. */
  async discoverAssets(issuers: readonly SupportedIssuer[] = ISSUERS): Promise<DiscoveryResult> {
    const settled = await Promise.allSettled(
      issuers.map((platformId) => this.client.rwa.tokens({ binanceChainId: BSC, platformId })),
    );
    // Every issuer failed: surface the real error instead of an empty "success".
    if (settled.every((r) => r.status === "rejected")) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }

    const assets: DiscoveredAsset[] = [];
    const errors: PartialError[] = [];
    let skipped = 0;

    settled.forEach((r, i) => {
      const issuer = issuers[i]!;
      if (r.status === "rejected") {
        errors.push(toError(`rwa.tokens:${issuer}`, r.reason));
        return;
      }
      for (const t of r.value.data ?? []) {
        // Defensive: keep only BSC even though we filtered server-side.
        if (t.binanceChainId != null && t.binanceChainId !== BSC) continue;
        const a = normaliseToken(t, issuer);
        if (a) assets.push(a);
        else skipped++;
      }
    });

    const byTicker = new Map<string, DiscoveredAsset[]>();
    for (const a of assets) {
      if (!a.underlyingTicker) continue;
      const key = a.underlyingTicker.toUpperCase();
      byTicker.set(key, [...(byTicker.get(key) ?? []), a]);
    }
    const crossIssuerTickers = [...byTicker.entries()]
      .map(([ticker, list]) => ({
        ticker,
        issuers: [...new Set(list.map((a) => a.issuer))],
        addresses: list.map((a) => a.address),
      }))
      .filter((g) => g.issuers.length >= 2)
      .sort((a, b) => a.ticker.localeCompare(b.ticker));

    return { chainId: BSC, fetchedAt: this.now(), assets, crossIssuerTickers, skipped, errors };
  }

  /** Market status for one token, from /rwa/underlying-market. */
  async marketStatus(address: string): Promise<{ address: string; status: MarketStatusView; fetchedAt: number }> {
    const { data } = await this.client.rwa.underlyingMarket({ binanceChainId: BSC, tokenContractAddress: address });
    return { address, status: toMarketStatus(data?.statusInfo), fetchedAt: this.now() };
  }

  /**
   * Everything about one tokenized stock, fetched in parallel.
   * A failed sub-call leaves its section null and is listed in `errors`.
   */
  async getAssetInfo(address: string): Promise<{
    address: string;
    fetchedAt: number;
    profile: RwaUnderlyingProfile | null;
    market: RwaUnderlyingMarket["marketData"] | null;
    status: MarketStatusView;
    price: RwaPrice | null;
    relationship: PriceRelationship;
    errors: PartialError[];
  }> {
    const token = { binanceChainId: BSC, tokenContractAddress: address };
    const [profileR, marketR, priceR] = await Promise.allSettled([
      this.client.rwa.underlyingProfile(token),
      this.client.rwa.underlyingMarket(token),
      this.client.rwa.price({ binanceChainId: BSC, tokenContractAddresses: [address] }),
    ]);

    // All three failed: surface the real error instead of an all-null "success".
    if (profileR.status === "rejected" && marketR.status === "rejected" && priceR.status === "rejected") {
      throw profileR.reason;
    }

    const errors: PartialError[] = [];
    const profile = profileR.status === "fulfilled" ? (profileR.value.data ?? null) : (errors.push(toError("rwa.underlyingProfile", profileR.reason)), null);
    const market = marketR.status === "fulfilled" ? (marketR.value.data ?? null) : (errors.push(toError("rwa.underlyingMarket", marketR.reason)), null);
    const price =
      priceR.status === "fulfilled"
        ? (priceR.value.data ?? []).find((p) => p.tokenContractAddress?.toLowerCase() === address.toLowerCase()) ?? null
        : (errors.push(toError("rwa.price", priceR.reason)), null);

    return {
      address,
      fetchedAt: this.now(),
      profile,
      market: market?.marketData ?? null,
      status: toMarketStatus(market?.statusInfo),
      price,
      relationship: priceRelationship(price ?? undefined, profile?.tokenToShareRatio, this.now()),
      errors,
    };
  }

  /** Batch price relationship (≤100 tokens). Ratios come from discovery or profiles you already hold. */
  async priceRelationships(
    tokens: Array<{ address: string; tokenToShareRatio: string | null }>,
  ): Promise<Array<{ address: string; relationship: PriceRelationship }>> {
    const { data } = await this.client.rwa.price({
      binanceChainId: BSC,
      tokenContractAddresses: tokens.map((t) => t.address),
    });
    const byAddress = new Map((data ?? []).map((p) => [p.tokenContractAddress?.toLowerCase(), p]));
    const now = this.now();
    return tokens.map((t) => ({
      address: t.address,
      relationship: priceRelationship(byAddress.get(t.address.toLowerCase()), t.tokenToShareRatio ?? undefined, now),
    }));
  }
}
