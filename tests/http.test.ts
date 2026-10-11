import { describe, expect, it, vi } from "vitest";
import { parseRateLimitHeaders } from "../src/lib/binance/http";
import { BinanceApiError } from "../src/lib/binance/errors";
import { ENDPOINTS } from "../src/lib/binance/endpoints";
import { signRequest } from "../src/lib/binance/signer";
import { RwaTokensSchema } from "../src/lib/binance/schemas";
import { createLogger } from "../src/lib/logging/logger";
import { envelope, FIXED_NOW, fakeFetch, httpClient, json, TEST_KEY, TEST_SECRET } from "./helpers";

describe("authentication", () => {
  it("sends X-OC headers whose signature verifies against the exact wire path", async () => {
    const { impl, calls } = fakeFetch([json(200, envelope([]))]);
    await httpClient(impl).request(ENDPOINTS.rwaTokens, { query: { binanceChainId: "56", platformId: "bstock" } });

    const call = calls[0]!;
    expect(call.url).toBe("https://web3.binance.com/build/api/v1/dex/market/rwa/tokens?binanceChainId=56&platformId=bstock");
    const h = call.init.headers as Record<string, string>;
    expect(h["X-OC-APIKEY"]).toBe(TEST_KEY);
    expect(h["X-OC-TIMESTAMP"]).toBe(FIXED_NOW.toISOString());
    expect(h["X-OC-RECV-WINDOW"]).toBe("5000");
    expect(h["X-OC-NONCE"]).toMatch(/^[0-9a-f-]{36}$/);
    const u = new URL(call.url);
    expect(h["X-OC-SIGN"]).toBe(signRequest(TEST_SECRET, FIXED_NOW.toISOString(), "GET", u.pathname + u.search, ""));
    expect(call.init.body).toBeUndefined();
    // The secret itself is never sent.
    expect(JSON.stringify(call)).not.toContain(TEST_SECRET);
  });

  it("signs POST bodies exactly as sent", async () => {
    const { impl, calls } = fakeFetch([json(200, envelope({ status: "SUCCESS" }))]);
    const body = { binanceChainId: "56", evmTx: { from: "0x1", to: "0x2", value: "0", data: "0x" } };
    await httpClient(impl).request(ENDPOINTS.simulate, { body });
    const call = calls[0]!;
    expect(call.init.body).toBe(JSON.stringify(body));
    expect((call.init.headers as Record<string, string>)["X-OC-SIGN"]).toBe(
      signRequest(TEST_SECRET, FIXED_NOW.toISOString(), "POST", "/build/api/v1/dex/pre-transaction/simulate", JSON.stringify(body)),
    );
  });

  it("refuses to construct without credentials", () => {
    expect(() => httpClient(fakeFetch([]).impl, { apiSecret: "" })).toThrow(/apiKey and apiSecret/);
  });
});

describe("successful responses", () => {
  it("unwraps data, rate limits and server time", async () => {
    const { impl } = fakeFetch([
      json(200, envelope([{ platformId: "bstock", tokenSymbol: "XYZ" }]), {
        "x-oc-ratelimit-limit": "100",
        "x-oc-ratelimit-remaining": "99",
      }),
    ]);
    const res = await httpClient(impl).request(ENDPOINTS.rwaTokens, { schema: RwaTokensSchema });
    expect(res.data).toEqual([{ platformId: "bstock", tokenSymbol: "XYZ" }]);
    expect(res.rateLimit).toEqual({ limit: 100, remaining: 99 });
    expect(res.serverTime).toBe(FIXED_NOW.getTime());
  });

  it("allows null data (e.g. /aggregator/history for an unknown tx)", async () => {
    const { impl } = fakeFetch([json(200, envelope(null))]);
    expect((await httpClient(impl).request(ENDPOINTS.swapTxStatus)).data).toBeNull();
  });

  it("keeps unknown extra fields (loose schemas)", async () => {
    const { impl } = fakeFetch([json(200, envelope([{ tokenSymbol: "XYZ", brandNewField: 1 }]))]);
    const res = await httpClient(impl).request<Array<Record<string, unknown>>>(ENDPOINTS.rwaTokens, { schema: RwaTokensSchema });
    expect(res.data[0]!.brandNewField).toBe(1);
  });
});

describe("API failures", () => {
  it("treats a non-zero envelope code on HTTP 200 as a business error (not retried)", async () => {
    const { impl, calls } = fakeFetch([json(200, { code: 40401, msg: "QUOTE_EXPIRED", data: null })]);
    const err = await httpClient(impl).request(ENDPOINTS.quote).catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err.kind).toBe("business");
    expect(err.code).toBe(40401);
    expect(calls).toHaveLength(1);
  });

  it("does not retry 401 (bad key) and keeps the upstream code", async () => {
    const { impl, calls } = fakeFetch([json(401, { code: 40101, msg: "API Key is required" })]);
    const err = await httpClient(impl).request(ENDPOINTS.rwaTokens).catch((e) => e);
    expect([err.kind, err.httpStatus, err.code]).toEqual(["http", 401, 40101]);
    expect(calls).toHaveLength(1);
  });

  it("retries GET on 429 honouring Retry-After, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const { impl, calls } = fakeFetch([json(429, { code: 1, msg: "busy" }, { "retry-after": "2" }), json(200, envelope([]))]);
    const res = await httpClient(impl, { sleep }).request(ENDPOINTS.rwaPlatforms);
    expect(res.data).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up after maxRetries on repeated 5xx", async () => {
    const { impl, calls } = fakeFetch([json(503, {}), json(503, {}), json(503, {})]);
    const err = await httpClient(impl).request(ENDPOINTS.rwaPlatforms).catch((e) => e);
    expect(err.httpStatus).toBe(503);
    expect(calls).toHaveLength(3);
  });

  it("never retries POST", async () => {
    const { impl, calls } = fakeFetch([json(503, { code: 1, msg: "down" })]);
    await httpClient(impl).request(ENDPOINTS.simulate, { body: {} }).catch(() => {});
    expect(calls).toHaveLength(1);
  });

  it("maps fetch rejections to network errors", async () => {
    const { impl } = fakeFetch([() => Promise.reject(new TypeError("fetch failed"))]);
    const err = await httpClient(impl, { maxRetries: 0 }).request(ENDPOINTS.rwaPlatforms).catch((e) => e);
    expect(err.kind).toBe("network");
  });
});

describe("malformed responses", () => {
  it("rejects non-JSON bodies (e.g. an HTML redirect page)", async () => {
    const { impl } = fakeFetch([() => new Response("<html>redirect</html>", { status: 200 })]);
    const err = await httpClient(impl).request(ENDPOINTS.rwaTokens).catch((e) => e);
    expect(err.kind).toBe("parse");
  });

  it("rejects JSON that is not an envelope", async () => {
    const { impl } = fakeFetch([json(200, [1, 2, 3])]);
    expect((await httpClient(impl).request(ENDPOINTS.rwaTokens).catch((e) => e)).kind).toBe("parse");
  });

  it("rejects a data payload with the wrong shape and names the path", async () => {
    // Spec: tokenPrice is a decimal STRING. A number means the contract drifted.
    const { impl } = fakeFetch([json(200, envelope([{ tokenSymbol: "XYZ", tokenPrice: 12.5 }]))]);
    const err = await httpClient(impl).request(ENDPOINTS.rwaTokens, { schema: RwaTokensSchema }).catch((e) => e);
    expect(err.kind).toBe("parse");
    expect(err.issues[0].path).toBe("data.0.tokenPrice");
  });

  it("rejects an object where an array was promised", async () => {
    const { impl } = fakeFetch([json(200, envelope({ list: [] }))]);
    const err = await httpClient(impl).request(ENDPOINTS.rwaTokens, { schema: RwaTokensSchema }).catch((e) => e);
    expect(err.kind).toBe("parse");
  });
});

describe("timeouts", () => {
  /** A fetch that never answers but honours the abort signal, like real fetch. */
  const hangingFetch = () =>
    fakeFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );

  it("aborts after timeoutMs and reports kind 'timeout'", async () => {
    const { impl } = hangingFetch();
    const started = Date.now();
    const err = await httpClient(impl, { timeoutMs: 50, maxRetries: 0 }).request(ENDPOINTS.rwaPlatforms).catch((e) => e);
    expect(err).toBeInstanceOf(BinanceApiError);
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/timed out after 50 ms/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("retries GET timeouts but not POST timeouts", async () => {
    const get = hangingFetch();
    await httpClient(get.impl, { timeoutMs: 20, maxRetries: 1 }).request(ENDPOINTS.rwaPlatforms).catch(() => {});
    expect(get.calls).toHaveLength(2);

    const post = hangingFetch();
    await httpClient(post.impl, { timeoutMs: 20, maxRetries: 1 }).request(ENDPOINTS.simulate, { body: {} }).catch(() => {});
    expect(post.calls).toHaveLength(1);
  });
});

describe("logging", () => {
  it("logs outcomes without the API key, secret, signature or headers", async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: "debug", sink: (_l, line) => lines.push(line), secrets: [TEST_KEY, TEST_SECRET] });
    const { impl, calls } = fakeFetch([
      json(200, envelope([])),
      // An upstream error body that (pathologically) echoes our key.
      json(400, { code: 40001, msg: `bad key ${TEST_KEY}` }),
    ]);
    const client = httpClient(impl, { logger });
    await client.request(ENDPOINTS.rwaPlatforms);
    await client.request(ENDPOINTS.rwaTokens).catch(() => {});

    const all = lines.join("\n");
    const sentSignature = (calls[0]!.init.headers as Record<string, string>)["X-OC-SIGN"]!;
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(all).not.toContain(TEST_KEY);
    expect(all).not.toContain(TEST_SECRET);
    expect(all).not.toContain(sentSignature);
    expect(all).not.toMatch(/X-OC-/i);
    const ok = JSON.parse(lines[0]!);
    expect(ok).toMatchObject({ level: "info", msg: "binance.request.ok", endpoint: "GET /api/v1/dex/market/rwa/platforms" });
    expect(typeof ok.latencyMs).toBe("number");
  });
});

describe("misc", () => {
  it("substitutes and encodes path params", async () => {
    const { impl, calls } = fakeFetch([json(200, envelope({ status: "FILLED" }))]);
    await httpClient(impl).request(ENDPOINTS.rfqOrderStatus, { pathParams: { orderId: "abc/123" } });
    expect(calls[0]!.url).toBe("https://web3.binance.com/build/api/v1/dex/aggregator/order/abc%2F123");
  });

  it("parses X-OC rate-limit headers", () => {
    expect(
      parseRateLimitHeaders(new Headers({ "x-oc-ratelimit-limit": "100", "x-oc-ratelimit-remaining": "7", "x-oc-used-weight": "93" })),
    ).toEqual({ limit: 100, remaining: 7, usedWeight: 93 });
  });
});
