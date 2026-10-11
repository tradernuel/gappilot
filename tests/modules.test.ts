import { describe, expect, it } from "vitest";
import { BinanceApiError } from "../src/lib/binance/errors";
import { ADDR, apiClient, envelope, fakeFetch, json } from "./helpers";

/** Asserts a call fails validation and that NOTHING was sent. */
async function expectValidationError(fn: () => Promise<unknown>, calls: unknown[], pathFragment: string) {
  const err = (await fn().catch((e: unknown) => e)) as BinanceApiError;
  expect(err).toBeInstanceOf(BinanceApiError);
  expect(err.kind).toBe("validation");
  expect(JSON.stringify(err.issues)).toContain(pathFragment);
  expect(calls).toHaveLength(0);
}

describe("RWA client", () => {
  it("joins price addresses with commas", async () => {
    const { impl, calls } = fakeFetch([json(200, envelope([]))]);
    await apiClient(impl).rwa.price({ binanceChainId: "56", tokenContractAddresses: [ADDR.a, ADDR.b] });
    expect(calls[0]!.url).toContain(`tokenContractAddresses=${ADDR.a}%2C${ADDR.b}`);
  });

  it("validates addresses, batch size, chain id and tab id before sending", async () => {
    const { impl, calls } = fakeFetch([]);
    const c = apiClient(impl);
    await expectValidationError(() => c.rwa.underlyingMarket({ binanceChainId: "56", tokenContractAddress: "0xnope" }), calls, "tokenContractAddress");
    await expectValidationError(
      () => c.rwa.price({ binanceChainId: "56", tokenContractAddresses: Array.from({ length: 101 }, () => ADDR.a) }),
      calls,
      "tokenContractAddresses",
    );
    await expectValidationError(() => c.rwa.price({ binanceChainId: "56", tokenContractAddresses: [] }), calls, "tokenContractAddresses");
    await expectValidationError(() => c.rwa.tokens({ binanceChainId: "bsc" }), calls, "binanceChainId");
    await expectValidationError(() => c.rwa.tokens({ tabId: 99 }), calls, "tabId");
    await expectValidationError(() => c.rwa.search({ keyword: "  " }), calls, "keyword");
  });
});

describe("Market client", () => {
  it("sends basic-info as POST with query params and no body", async () => {
    const { impl, calls } = fakeFetch([json(200, envelope({ decimals: 18 }))]);
    await apiClient(impl).market.basicInfo({ binanceChainId: "56", tokenContractAddress: ADDR.a });
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.url).toContain(`tokenContractAddress=${ADDR.a}`);
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("leaves undocumented price endpoints as explicit integration points", () => {
    const c = apiClient(fakeFetch([]).impl);
    expect(() => c.market.tokenPrice()).toThrow(/undocumented/);
    expect(() => c.market.tokenTradingInfo()).toThrow(/undocumented/);
  });
});

describe("Wallet client", () => {
  it("rejects multiple chains and >20 tokens", async () => {
    const { impl, calls } = fakeFetch([]);
    const c = apiClient(impl);
    await expectValidationError(() => c.wallet.allTokenBalances({ address: ADDR.wallet, chains: "56,1" }), calls, "chains");
    await expectValidationError(
      () =>
        c.wallet.tokenBalances({
          address: ADDR.wallet,
          tokenContractAddresses: Array.from({ length: 21 }, () => ({ binanceChainId: "56", tokenContractAddress: ADDR.a })),
        }),
      calls,
      "tokenContractAddresses",
    );
  });

  it("allows the empty-string native asset in tokenBalances", async () => {
    const { impl, calls } = fakeFetch([json(200, envelope([{ tokenAssets: [] }]))]);
    await apiClient(impl).wallet.tokenBalances({
      address: ADDR.wallet,
      tokenContractAddresses: [{ binanceChainId: "56", tokenContractAddress: "" }],
    });
    expect(JSON.parse(String(calls[0]!.init.body)).tokenContractAddresses[0].tokenContractAddress).toBe("");
  });
});

describe("Trading client (read-only)", () => {
  it("rejects decimal amounts and identical tokens", async () => {
    const { impl, calls } = fakeFetch([]);
    const c = apiClient(impl);
    await expectValidationError(
      () => c.trading.quote({ binanceChainId: "56", amount: "1.5", fromTokenAddress: ADDR.a, toTokenAddress: ADDR.b }),
      calls,
      "amount",
    );
    await expectValidationError(
      () => c.trading.quote({ binanceChainId: "56", amount: "100", fromTokenAddress: ADDR.a, toTokenAddress: ADDR.a.toUpperCase().replace("0X", "0x") }),
      calls,
      "toTokenAddress",
    );
  });

  it("requires slippage unless autoSlippage, and serialises booleans as strings", async () => {
    const base = { binanceChainId: "56", amount: "1", fromTokenAddress: ADDR.a, toTokenAddress: ADDR.b, userWalletAddress: ADDR.wallet, quoteId: "q" };
    const none = fakeFetch([]);
    await expectValidationError(() => apiClient(none.impl).trading.buildSwap(base), none.calls, "slippagePercent");

    const ok = fakeFetch([json(200, envelope({ executionMode: "RFQ" }))]);
    await apiClient(ok.impl).trading.buildSwap({ ...base, autoSlippage: true });
    expect(ok.calls[0]!.url).toContain("autoSlippage=true");
    expect(ok.calls[0]!.url).not.toContain("approveTransaction=");
  });

  it("has no order-submission method (execution not built)", () => {
    const t = apiClient(fakeFetch([]).impl).trading as unknown as Record<string, unknown>;
    expect(t.submitRfqOrder).toBeUndefined();
  });
});

describe("Transaction client", () => {
  it("validates the EVM tx before simulating", async () => {
    const { impl, calls } = fakeFetch([]);
    await expectValidationError(
      () => apiClient(impl).transaction.simulate({ binanceChainId: "56", evmTx: { from: ADDR.wallet, to: ADDR.a, value: "-1", data: "0x" } }),
      calls,
      "evmTx.value",
    );
  });

  it("does not expose broadcast", () => {
    const t = apiClient(fakeFetch([]).impl).transaction as unknown as Record<string, unknown>;
    expect(t.broadcast).toBeUndefined();
  });
});
