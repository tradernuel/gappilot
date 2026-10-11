/**
 * OpportunityScanner — gathers live data and runs the deterministic engine.
 *
 * Signal: CROSS_ISSUER. For every ticker listed by ≥2 issuers on BSC, each
 * token is evaluated against the other issuer's per-share price.
 *
 * Calls per scan (P pairs, 2P tokens): 2× rwa/tokens, ⌈2P/100⌉× rwa/price,
 * 2P× top-liquidity, and with a wallet: 1× basic-info, ⌈(2P+1)/20⌉× balances,
 * and one quote per leg whose spread clears the noise band.
 *
 * Read-only. Quotes are fetched to price execution; nothing is built or signed.
 */
import type { BinanceWeb3Client } from "../binance/facade";
import { BinanceApiError } from "../binance/errors";
import type { RwaPrice, TokenBalance } from "../binance/types";
import { BSC, RwaService, type DiscoveredAsset, type PartialError } from "../rwa/rwa-service";
import { crossIssuerReference, quoteFromRoute, selectBestRoute, sumLiquidity, walletInput } from "./adapters";
import { numberToRawCeil, perSharePrice, calculateSpreadPercent } from "./calculations";
import { EngineInputError, evaluateOpportunity, rankOpportunities } from "./evaluate";
import { DEFAULT_POLICY, type EnginePolicy, type LiquidityInput, type Opportunity, type QuoteInput } from "./types";

export interface ScanOptions {
  /** Size to evaluate, in quote-token units (≈ USD). */
  notional: number;
  wallet?: string;
  quoteTokenAddress: string;
  maxPairs?: number;
  policy?: Partial<EnginePolicy>;
}

export interface ScanResult {
  evaluatedAt: number;
  signal: "CROSS_ISSUER";
  notional: number;
  walletConnected: boolean;
  /** Every tokenized equity discovered on BSC across issuers (monitored), compared or not. */
  assetsDiscovered: number;
  pairsFound: number;
  pairsScanned: number;
  opportunities: Opportunity[];
  errors: PartialError[];
}

const errOf = (source: string, e: unknown): PartialError =>
  e instanceof BinanceApiError
    ? { source, kind: e.kind, message: e.message, code: e.code }
    : { source, kind: e instanceof EngineInputError ? "engine_input" : "unknown", message: e instanceof Error ? e.message : String(e) };

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

export class OpportunityScanner {
  constructor(
    private readonly client: BinanceWeb3Client,
    private readonly now: () => number = Date.now,
  ) {}

  async scan(opts: ScanOptions): Promise<ScanResult> {
    const policy = { ...DEFAULT_POLICY, ...opts.policy };
    const errors: PartialError[] = [];
    const discovery = await new RwaService(this.client, this.now).discoverAssets();
    errors.push(...discovery.errors);

    // One asset per issuer per ticker.
    const pairs: Array<[DiscoveredAsset, DiscoveredAsset]> = [];
    for (const g of discovery.crossIssuerTickers) {
      const byIssuer = new Map<string, DiscoveredAsset>();
      for (const a of discovery.assets) {
        if (a.underlyingTicker?.toUpperCase() === g.ticker && !byIssuer.has(a.issuer)) byIssuer.set(a.issuer, a);
      }
      const [x, y] = [...byIssuer.values()];
      if (x && y) pairs.push([x, y]);
    }
    const scanned = pairs.slice(0, opts.maxPairs ?? 10);
    const assets = scanned.flat();

    // Prices (batch ≤100), liquidity (per token).
    const prices = new Map<string, RwaPrice>();
    for (const batch of chunk(assets.map((a) => a.address), 100)) {
      try {
        const { data } = await this.client.rwa.price({ binanceChainId: BSC, tokenContractAddresses: batch });
        for (const p of data ?? []) if (p.tokenContractAddress) prices.set(p.tokenContractAddress.toLowerCase(), p);
      } catch (e) {
        errors.push(errOf("rwa.price", e));
      }
    }
    const liquidity = new Map<string, LiquidityInput | null>();
    await Promise.all(
      assets.map(async (a) => {
        try {
          const { data } = await this.client.market.topLiquidity({ binanceChainId: BSC, tokenContractAddress: a.address });
          liquidity.set(a.address, sumLiquidity(data));
        } catch (e) {
          liquidity.set(a.address, null);
          errors.push(errOf(`market.topLiquidity:${a.symbol ?? a.address}`, e));
        }
      }),
    );

    // Wallet: stable decimals + balances.
    let stableDecimals: number | null = null;
    let balances: TokenBalance[] | null = null;
    let balancesAt = this.now();
    if (opts.wallet) {
      try {
        const { data } = await this.client.market.basicInfo({ binanceChainId: BSC, tokenContractAddress: opts.quoteTokenAddress });
        stableDecimals = typeof data?.decimals === "number" ? data.decimals : null;
        if (stableDecimals === null) errors.push({ source: "market.basicInfo", kind: "missing", message: "quote token decimals unavailable" });
      } catch (e) {
        errors.push(errOf("market.basicInfo", e));
      }
      try {
        balances = [];
        const tokens = [opts.quoteTokenAddress, ...assets.map((a) => a.address)];
        for (const batch of chunk(tokens, 20)) {
          const { data } = await this.client.wallet.tokenBalances({
            address: opts.wallet,
            tokenContractAddresses: batch.map((t) => ({ binanceChainId: BSC, tokenContractAddress: t })),
          });
          for (const row of data ?? []) balances.push(...(row.tokenAssets ?? []));
        }
        balancesAt = this.now();
      } catch (e) {
        balances = null;
        errors.push(errOf("wallet.tokenBalances", e));
      }
    }

    const opportunities: Opportunity[] = [];
    for (const [x, y] of scanned) {
      for (const [self, other] of [[x, y], [y, x]] as const) {
        const result = await this.evaluateLeg(self, other, prices, liquidity, opts, policy, stableDecimals, balances, balancesAt, errors);
        if (result) opportunities.push(result);
      }
    }

    return {
      evaluatedAt: this.now(),
      signal: "CROSS_ISSUER",
      notional: opts.notional,
      walletConnected: !!opts.wallet && balances !== null,
      assetsDiscovered: discovery.assets.length,
      pairsFound: pairs.length,
      pairsScanned: scanned.length,
      opportunities: rankOpportunities(opportunities),
      errors,
    };
  }

  private async evaluateLeg(
    self: DiscoveredAsset,
    other: DiscoveredAsset,
    prices: Map<string, RwaPrice>,
    liquidity: Map<string, LiquidityInput | null>,
    opts: ScanOptions,
    policy: EnginePolicy,
    stableDecimals: number | null,
    balances: TokenBalance[] | null,
    balancesAt: number,
    errors: PartialError[],
  ): Promise<Opportunity | null> {
    const label = `${self.underlyingTicker}:${self.issuer}`;
    const p = prices.get(self.address.toLowerCase());
    const q = prices.get(other.address.toLowerCase());
    const selfPrice = Number(p?.tokenPrice);
    const otherPrice = Number(q?.tokenPrice);
    const selfRatio = Number(self.tokenToShareRatio);
    const otherRatio = Number(other.tokenToShareRatio);
    const otherPerShare = perSharePrice(otherPrice, otherRatio);
    const selfPerShare = perSharePrice(selfPrice, selfRatio);

    if (selfPerShare === null || otherPerShare === null || self.decimals === null) {
      errors.push({ source: `engine:${label}`, kind: "missing", message: "price, tokenToShareRatio or decimals unavailable; leg skipped" });
      return null;
    }

    // Quote only legs that clear the noise band (saves calls; IGNORE legs don't need costs).
    let quote: QuoteInput | null = null;
    const spreadPct = calculateSpreadPercent(selfPerShare, otherPerShare)!;
    if (opts.wallet && stableDecimals !== null && Math.abs(spreadPct) * 100 >= policy.minSpreadBps) {
      const side = spreadPct > 0 ? "SELL_TOKEN" : "BUY_TOKEN";
      const amount =
        side === "BUY_TOKEN"
          ? numberToRawCeil(opts.notional, stableDecimals)
          : numberToRawCeil(opts.notional / selfPrice, self.decimals);
      if (amount !== null && amount > 0n) {
        try {
          const fetchedAt = this.now();
          const { data } = await this.client.trading.quote({
            binanceChainId: BSC,
            amount: amount.toString(),
            fromTokenAddress: side === "BUY_TOKEN" ? opts.quoteTokenAddress : self.address,
            toTokenAddress: side === "BUY_TOKEN" ? self.address : opts.quoteTokenAddress,
            userWalletAddress: opts.wallet,
          });
          const route = selectBestRoute(data);
          quote = route
            ? quoteFromRoute(route, side, fetchedAt, {
                from: side === "BUY_TOKEN" ? stableDecimals : self.decimals,
                to: side === "BUY_TOKEN" ? self.decimals : stableDecimals,
              })
            : null;
        } catch (e) {
          errors.push(errOf(`trading.quote:${label}`, e));
        }
      }
    }

    try {
      return evaluateOpportunity({
        asset: {
          address: self.address,
          issuer: self.issuer,
          symbol: self.symbol ?? self.address,
          underlyingTicker: self.underlyingTicker ?? "",
          decimals: self.decimals,
          tokenToShareRatio: selfRatio,
        },
        onChain: { tokenPriceUsd: selfPrice, updatedAt: p?.tokenPriceUpdatedAt ?? null },
        reference: crossIssuerReference({
          address: other.address,
          issuer: other.issuer,
          symbol: other.symbol ?? other.address,
          perSharePriceUsd: otherPerShare,
          updatedAt: q?.tokenPriceUpdatedAt ?? null,
        }),
        market: self.status,
        liquidity: liquidity.get(self.address) ?? null,
        notional: opts.notional,
        quote,
        wallet:
          opts.wallet && balances && stableDecimals !== null
            ? walletInput({
                address: opts.wallet,
                assets: balances,
                token: { address: self.address, decimals: self.decimals },
                stable: { address: opts.quoteTokenAddress, decimals: stableDecimals },
                fetchedAt: balancesAt,
              })
            : null,
        now: this.now(),
        policy,
      });
    } catch (e) {
      errors.push(errOf(`engine:${label}`, e));
      return null;
    }
  }
}
