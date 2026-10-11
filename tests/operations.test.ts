import { describe, expect, it } from "vitest";
import { runOperation } from "../src/lib/binance/server/operations";
import { ADDR, apiClient, envelope, fakeFetch, json, TEST_KEY, TEST_SECRET } from "./helpers";

describe("server operations (/api/binance/*)", () => {
  it("returns 404 / 405 for unknown ops and wrong methods", async () => {
    const c = apiClient(fakeFetch([]).impl);
    expect((await runOperation(c, "rwa/nope", "GET", {})).status).toBe(404);
    expect((await runOperation(c, "transaction/simulate", "GET", {})).status).toBe(405);
  });

  it("returns 400 with field issues for bad input and makes no upstream call", async () => {
    const { impl, calls } = fakeFetch([]);
    const res = await runOperation(apiClient(impl), "rwa/asset", "GET", { address: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).toContain("address");
    expect(calls).toHaveLength(0);
  });

  it("pins the chain to BSC", async () => {
    const { impl, calls } = fakeFetch([json(200, envelope([]))]);
    await runOperation(apiClient(impl), "rwa/tokens", "GET", { platformId: "ondo", binanceChainId: "1" });
    expect(new URL(calls[0]!.url).searchParams.get("binanceChainId")).toBe("56");
  });

  it("maps upstream failures: business → 502, 429 → 429, timeout → 504", async () => {
    const business = await runOperation(apiClient(fakeFetch([json(200, { code: 40001, msg: "PARAM_ERROR" })]).impl), "transaction/gas-price", "GET", {});
    expect(business.status).toBe(502);
    expect(business.body).toMatchObject({ ok: false, error: { kind: "business", code: 40001 } });

    const limited = await runOperation(apiClient(fakeFetch([json(429, {})]).impl, { maxRetries: 0 }), "transaction/gas-price", "GET", {});
    expect(limited.status).toBe(429);

    const hanging = fakeFetch((_u, init) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
    const timeout = await runOperation(apiClient(hanging.impl, { timeoutMs: 20, maxRetries: 0 }), "transaction/gas-price", "GET", {});
    expect(timeout.status).toBe(504);
  });

  it("returns typed data on success and never leaks credentials", async () => {
    const { impl } = fakeFetch([json(200, envelope([{ tokenContractAddress: ADDR.a, tokenPrice: "1" }]))]);
    const res = await runOperation(apiClient(impl), "rwa/price", "GET", { addresses: `${ADDR.a}` });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: [{ tokenContractAddress: ADDR.a }] });
    const out = JSON.stringify(res.body);
    expect(out).not.toContain(TEST_KEY);
    expect(out).not.toContain(TEST_SECRET);
  });

  it("does not echo upstream bodies to the caller", async () => {
    const { impl } = fakeFetch([json(401, { code: 40101, msg: "API Key is required", internalDebug: "x" })]);
    const res = await runOperation(apiClient(impl), "rwa/platforms", "GET", {});
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain("internalDebug");
  });
});

describe("opportunities/scan operation", () => {
  it("validates notional and refuses to run without a server-configured quote token", async () => {
    const { impl, calls } = fakeFetch([]);
    const bad = await runOperation(apiClient(impl), "opportunities/scan", "GET", { notional: "-5" }, { quoteTokenAddress: ADDR.quote });
    expect(bad.status).toBe(400);
    const noCtx = await runOperation(apiClient(impl), "opportunities/scan", "GET", {});
    expect(noCtx.status).toBe(500);
    expect(calls).toHaveLength(0);
  });
});
