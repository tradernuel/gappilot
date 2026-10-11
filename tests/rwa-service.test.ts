import { describe, expect, it } from "vitest";
import { priceRelationship, RwaService, toMarketStatus, toPositiveNumber } from "../src/lib/rwa/rwa-service";
import { ADDR, apiClient, envelope, fakeFetch, json } from "./helpers";

describe("priceRelationship", () => {
  // Synthetic inputs chosen to make the arithmetic obvious. Not market data.
  it("derives implied ratio, deviation and per-share price", () => {
    const r = priceRelationship({ tokenPrice: "200", referencePrice: "100", tokenPriceUpdatedAt: 1_000 }, "2", 61_000);
    expect(r.impliedRatio).toBe(2);
    expect(r.ratioDeviationBps).toBe(0);
    expect(r.perSharePriceUsd).toBe(100);
    expect(r.priceAgeMs).toBe(60_000);
    expect(r.referenceIsDerivedFromToken).toBe(true);
  });

  it("reports deviation when referencePrice is not the ratio-converted token price", () => {
    const r = priceRelationship({ tokenPrice: "101", referencePrice: "100" }, "1");
    expect(r.ratioDeviationBps).toBeCloseTo(100, 6);
  });

  it("returns nulls rather than inventing values", () => {
    const r = priceRelationship({ tokenPrice: "", referencePrice: "abc" }, undefined);
    expect([r.tokenPriceUsd, r.referencePriceUsd, r.impliedRatio, r.perSharePriceUsd, r.priceAgeMs]).toEqual([null, null, null, null, null]);
    expect(toPositiveNumber("0")).toBeNull();
    expect(toPositiveNumber("-5")).toBeNull();
  });
});

describe("toMarketStatus", () => {
  it("marks unavailable when statusInfo is missing", () => {
    expect(toMarketStatus(undefined)).toMatchObject({ available: false, isHardBlocked: false });
  });

  it("hard-blocks corporate actions and maintenance, not ordinary closes", () => {
    expect(toMarketStatus({ openState: false, reasonCode: "ASSET_PAUSED", reasonMsg: "stock_split" }).isHardBlocked).toBe(true);
    expect(toMarketStatus({ openState: false, reasonCode: "MARKET_MAINTENANCE" }).isHardBlocked).toBe(true);
    expect(toMarketStatus({ openState: false, marketStatus: "closed", reasonCode: "MARKET_CLOSED" }).isHardBlocked).toBe(false);
  });

  it("tolerates null marketStatus (reported by other teams)", () => {
    expect(toMarketStatus({ openState: true, marketStatus: null, reasonCode: "TRADING" })).toMatchObject({
      available: true,
      marketStatus: null,
      isHardBlocked: false,
    });
  });
});

describe("RwaService.discoverAssets", () => {
  it("groups tickers across issuers and reports partial failures", async () => {
    const { impl } = fakeFetch((url) => {
      const platform = url.searchParams.get("platformId");
      if (platform === "bstock")
        return json(200, envelope([
          { binanceChainId: "56", tokenContractAddress: ADDR.a, platformId: "bstock", underlyingTicker: "XYZ", decimals: "18" },
          { binanceChainId: "56", platformId: "bstock", underlyingTicker: "NOADDR" },
        ]))(url, {});
      return json(200, envelope([
        { binanceChainId: "56", tokenContractAddress: ADDR.b, platformId: "ondo", underlyingTicker: "xyz" },
      ]))(url, {});
    });
    const res = await new RwaService(apiClient(impl), () => 42).discoverAssets();
    expect(res.assets).toHaveLength(2);
    expect(res.skipped).toBe(1);
    expect(res.crossIssuerTickers).toEqual([{ ticker: "XYZ", issuers: ["bstock", "ondo"], addresses: [ADDR.a, ADDR.b] }]);
    expect(res.assets[0]!.decimals).toBe(18);
    expect(res.errors).toEqual([]);
  });

  it("returns the issuers that worked when one fails", async () => {
    const { impl } = fakeFetch((url) =>
      url.searchParams.get("platformId") === "ondo"
        ? json(401, { code: 40101, msg: "API Key is required" })(url, {})
        : json(200, envelope([]))(url, {}),
    );
    const res = await new RwaService(apiClient(impl)).discoverAssets();
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ source: "rwa.tokens:ondo", kind: "http" });
  });
});

describe("RwaService.getAssetInfo", () => {
  it("combines profile, market, status and price; isolates sub-call failures", async () => {
    const { impl } = fakeFetch((url) => {
      if (url.pathname.endsWith("/underlying-profile")) return json(200, envelope({ underlyingTicker: "XYZ", tokenToShareRatio: "2" }))(url, {});
      if (url.pathname.endsWith("/underlying-market")) return json(500, {})(url, {});
      return json(200, envelope([{ tokenContractAddress: ADDR.a, tokenPrice: "200", referencePrice: "100", tokenPriceUpdatedAt: 0 }]))(url, {});
    });
    const info = await new RwaService(apiClient(impl, { maxRetries: 0 }), () => 1_000).getAssetInfo(ADDR.a);
    expect(info.profile?.underlyingTicker).toBe("XYZ");
    expect(info.status.available).toBe(false);
    expect(info.relationship).toMatchObject({ perSharePriceUsd: 100, impliedRatio: 2, priceAgeMs: 1_000 });
    expect(info.errors).toEqual([expect.objectContaining({ source: "rwa.underlyingMarket", kind: "http" })]);
  });
});

describe("RwaService total failure", () => {
  it("throws the upstream error when every issuer fails (no empty 'success')", async () => {
    const { impl } = fakeFetch(() => json(401, { code: 40101, msg: "API Key is required" })(new URL("http://x"), {}));
    const err = await new RwaService(apiClient(impl)).discoverAssets().catch((e) => e);
    expect(err).toMatchObject({ kind: "http", httpStatus: 401 });
  });

  it("throws when profile, market and price all fail", async () => {
    const { impl } = fakeFetch(() => json(503, {})(new URL("http://x"), {}));
    const err = await new RwaService(apiClient(impl, { maxRetries: 0 })).getAssetInfo(ADDR.a).catch((e) => e);
    expect(err).toMatchObject({ kind: "http", httpStatus: 503 });
  });
});
