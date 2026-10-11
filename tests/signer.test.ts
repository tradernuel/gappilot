import { describe, expect, it } from "vitest";
import { buildPrehash, buildRequestTarget, signRequest } from "../src/lib/binance/signer";

// Vectors computed independently with Python's hmac/hashlib (not with this code).
const TS = "2026-10-08T12:00:00.000Z";
const SECRET = "test-secret";

describe("buildRequestTarget", () => {
  it("keeps the /build prefix in both the URL and the signed path", () => {
    const { url, requestPath } = buildRequestTarget(
      "https://web3.binance.com/build",
      "/api/v1/dex/market/rwa/price",
      { binanceChainId: "56", tokenContractAddresses: "0xaaa,0xbbb" },
    );
    expect(requestPath).toBe(
      "/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xaaa%2C0xbbb",
    );
    expect(url).toBe(`https://web3.binance.com${requestPath}`);
  });

  it("tolerates a trailing slash on the base URL and drops undefined params", () => {
    const { requestPath } = buildRequestTarget("https://web3.binance.com/build/", "/api/v1/x", {
      a: "1",
      b: undefined,
      c: null,
    });
    expect(requestPath).toBe("/build/api/v1/x?a=1");
  });

  it("omits the ? when there are no query params", () => {
    expect(buildRequestTarget("https://web3.binance.com/build", "/api/v1/x", {}).requestPath).toBe(
      "/build/api/v1/x",
    );
  });
});

describe("signRequest", () => {
  it("concatenates timestamp + METHOD + path + body with no separators", () => {
    expect(buildPrehash(TS, "get", "/p?q=1", "")).toBe(`${TS}GET/p?q=1`);
  });

  it("matches an independent HMAC-SHA256/base64 vector for a GET", () => {
    const sig = signRequest(
      SECRET,
      TS,
      "GET",
      "/build/api/v1/dex/market/rwa/price?binanceChainId=56&tokenContractAddresses=0xaaa%2C0xbbb",
      "",
    );
    expect(sig).toBe("QtxPtYT55qVqE3/jH4pbEOep4DWcv0tRETqpqKRJQZc=");
  });

  it("matches an independent vector for a POST with a JSON body", () => {
    const body = JSON.stringify({
      binanceChainId: "56",
      evmTx: { from: "0x1", to: "0x2", value: "0", data: "0x" },
    });
    const sig = signRequest(SECRET, TS, "POST", "/build/api/v1/dex/pre-transaction/simulate", body);
    expect(sig).toBe("omE8Duc8pUt9mDIijvmqzzVRZE+ycb54ANpyaYx7WYc=");
  });
});
