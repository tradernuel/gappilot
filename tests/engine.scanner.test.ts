import { describe, expect, it } from "vitest";
import { quoteFromRoute, rawBalanceOf, selectBestRoute, sumLiquidity } from "../src/lib/engine/adapters";
import { OpportunityScanner } from "../src/lib/engine/scanner";
import { apiClient, envelope, fakeFetch, json } from "./helpers";

// Synthetic addresses and prices for tests only. Not real tokens or market data.
const A = "0xa000000000000000000000000000000000000001"; // issuer bstock, ticker XYZ
const B = "0xb000000000000000000000000000000000000002"; // issuer ondo,   ticker XYZ
const USDT = "0x5000000000000000000000000000000000000005";
const WALLET = "0x7000000000000000000000000000000000000007";
const NOW = 1_800_000_000_000;
const E18 = 10n ** 18n;

describe("adapters", () => {
  it("sumLiquidity sums usable pools; null when none", () => {
    expect(sumLiquidity([{ liquidityUsd: "100" }, { liquidityUsd: "50.5" }, { liquidityUsd: "x" }])).toEqual({ totalUsd: 150.5, poolCount: 3 });
    expect(sumLiquidity([])).toBeNull();
    expect(sumLiquidity([{ liquidityUsd: "" }])).toEqual({ totalUsd: null, poolCount: 1 });
  });

  it("selectBestRoute prefers isBest, else the largest output (BigInt compare)", () => {
    expect(selectBestRoute([{ toTokenAmount: "9" }, { toTokenAmount: "10", isBest: true }])!.toTokenAmount).toBe("10");
    expect(selectBestRoute([{ toTokenAmount: "99999999999999999999" }, { toTokenAmount: "100000000000000000000" }])!.toTokenAmount).toBe("100000000000000000000");
    expect(selectBestRoute([])).toBeNull();
  });

  it("quoteFromRoute maps decimals, stable price, taxes and honeypot flags", () => {
    const q = quoteFromRoute(
      {
        fromTokenAmount: "1000", toTokenAmount: "990", vendorName: "PcsXRfq", executionMode: "RFQ", tradeFee: "0.02", priceImpactPercent: "0.1",
        fromToken: { decimal: "6", tokenUnitPrice: "1.0001", taxRate: "0" },
        toToken: { decimal: "18", taxRate: "0.01", isHoneyPot: false },
      },
      "BUY_TOKEN",
      NOW,
    )!;
    expect(q).toMatchObject({ fromDecimals: 6, toDecimals: 18, stableUnitPriceUsd: 1.0001, taxRate: 0.01, tradeFeeUsd: 0.02, isHoneyPot: false });
    expect(quoteFromRoute({ fromTokenAmount: "1.5", toTokenAmount: "1" }, "BUY_TOKEN", NOW)).toBeNull();
  });

  it("rawBalanceOf uses rawBalance, falls back to balance (floored), and defaults to 0", () => {
    expect(rawBalanceOf([{ tokenContractAddress: A.toUpperCase().replace("0X", "0x"), rawBalance: "123" }], A, 18)).toBe("123");
    expect(rawBalanceOf([{ tokenContractAddress: A, rawBalance: "", balance: "1.5" }], A, 6)).toBe("1500000");
    expect(rawBalanceOf([], A, 18)).toBe("0");
  });
});

/** Fake Binance backend: XYZ on two issuers; bstock at $101/share, ondo at $100/share. */
function backend(opts: { walletTokens?: bigint; walletUsdt?: bigint; quoteCalls?: string[] } = {}) {
  return fakeFetch((url, init) => {
    const p = url.pathname.replace("/build", "");
    const q = url.searchParams;
    if (p.endsWith("/rwa/tokens")) {
      const platform = q.get("platformId");
      const token = platform === "bstock"
        ? { tokenContractAddress: A, platformId: "bstock", tokenSymbol: "XYZB", underlyingTicker: "XYZ", decimals: "18", tokenToShareRatio: "1" }
        : { tokenContractAddress: B, platformId: "ondo", tokenSymbol: "XYZon", underlyingTicker: "XYZ", decimals: "18", tokenToShareRatio: "2" };
      return json(200, envelope([{ binanceChainId: "56", ...token, statusInfo: { openState: true, marketStatus: "regular", reasonCode: "TRADING" } }]))(url, init);
    }
    if (p.endsWith("/rwa/price")) {
      return json(200, envelope([
        { tokenContractAddress: A, tokenPrice: "101", tokenPriceUpdatedAt: NOW - 5_000 },
        { tokenContractAddress: B, tokenPrice: "200", tokenPriceUpdatedAt: NOW - 5_000 }, // ratio 2 → $100/share
      ]))(url, init);
    }
    if (p.endsWith("/token/top-liquidity")) return json(200, envelope([{ liquidityUsd: "2000000" }]))(url, init);
    if (p.endsWith("/token/basic-info")) return json(200, envelope({ decimals: 18 }))(url, init);
    if (p.endsWith("/token-balances-by-address")) {
      return json(200, envelope([{ tokenAssets: [
        { tokenContractAddress: USDT, rawBalance: ((opts.walletUsdt ?? 0n) * E18).toString() },
        { tokenContractAddress: A, rawBalance: ((opts.walletTokens ?? 0n) * E18).toString() },
      ] }]))(url, init);
    }
    if (p.endsWith("/aggregator/quote")) {
      opts.quoteCalls?.push(`${q.get("fromTokenAddress")}->${q.get("toTokenAddress")}`);
      const amount = BigInt(q.get("amount")!);
      const selling = q.get("fromTokenAddress") === A;
      // 0.2% execution shortfall vs mid, in either direction.
      const out = selling ? (amount * 101n * 998n) / 1000n : (((amount * 998n) / 1000n) * 100n) / 20_000n; // B = $200/token
      return json(200, envelope([{
        quoteId: "q", vendorName: "PcsXRfq", executionMode: "RFQ", isBest: true, tradeFee: "0.05", priceImpactPercent: "0.2",
        fromTokenAmount: amount.toString(), toTokenAmount: out.toString(),
        fromToken: { decimal: "18", tokenUnitPrice: selling ? "101" : "1" }, toToken: { decimal: "18", tokenUnitPrice: selling ? "1" : "200" },
      }]))(url, init);
    }
    throw new Error(`unexpected ${p}`);
  });
}

describe("OpportunityScanner", () => {
  it("without a wallet: evaluates both legs, makes no quote calls, nothing above WATCH", async () => {
    const { impl, calls } = backend();
    const res = await new OpportunityScanner(apiClient(impl), () => NOW).scan({ notional: 1_000, quoteTokenAddress: USDT });
    expect(res.pairsFound).toBe(1);
    expect(res.assetsDiscovered).toBe(2);
    expect(res.opportunities).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("/aggregator/quote"))).toBe(false);
    const byIssuer = Object.fromEntries(res.opportunities.map((o) => [o.asset.issuer, o]));
    expect(byIssuer.bstock!.spreadPercent).toBeCloseTo(1); // $101 vs $100 per share
    expect(byIssuer.ondo!.spreadPercent).toBeCloseTo(-0.990, 2); // $100 vs $101
    expect(res.opportunities.every((o) => o.action === "WATCH")).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("with a wallet holding the premium token: the premium leg becomes EXECUTABLE", async () => {
    const quoteCalls: string[] = [];
    const { impl } = backend({ walletTokens: 20n, walletUsdt: 0n, quoteCalls });
    const res = await new OpportunityScanner(apiClient(impl), () => NOW).scan({ notional: 1_000, wallet: WALLET, quoteTokenAddress: USDT });
    const bstock = res.opportunities.find((o) => o.asset.issuer === "bstock")!;
    const ondo = res.opportunities.find((o) => o.asset.issuer === "ondo")!;
    expect(quoteCalls).toEqual([`${A}->${USDT}`, `${USDT}->${B}`]); // sell rich leg, buy cheap leg
    expect(bstock.action).toBe("EXECUTABLE");
    expect(bstock.estimatedSlippagePercent).toBeCloseTo(0.2, 1);
    // Ondo is at a discount, but the wallet has no USDT → not executable.
    expect(ondo.direction).toBe("DISCOUNT");
    expect(ondo.action).toBe("ACTIONABLE");
    expect(res.opportunities[0]!.asset.issuer).toBe("bstock"); // ranked first
  });

  it("records partial failures instead of failing the scan", async () => {
    const base = backend();
    const { impl } = fakeFetch((url, init) =>
      url.pathname.endsWith("/top-liquidity") ? json(500, {})(url, init) : (base.mock(url.toString(), init) as Promise<Response>),
    );
    const res = await new OpportunityScanner(apiClient(impl, { maxRetries: 0 }), () => NOW).scan({ notional: 1_000, quoteTokenAddress: USDT });
    expect(res.opportunities).toHaveLength(2);
    expect(res.opportunities.every((o) => o.liquidityUsd === null)).toBe(true);
    expect(res.errors.filter((e) => e.source.startsWith("market.topLiquidity"))).toHaveLength(2);
  });
});
