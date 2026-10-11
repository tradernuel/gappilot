import { describe, expect, it } from "vitest";
import { handleApi } from "../src/demo/api";
import { DEMO_WALLET, demoState } from "../src/demo/backend";
import type { Opportunity } from "../src/lib/engine/types";

/* The hosted demo runs the real scanner/agent/planner/policy on a simulated Binance API. */
const call = async (method: string, path: string, body: Record<string, unknown> = {}, query = "") => {
  const res = await handleApi(path, method, new URL(`https://demo.local${path}${query}`), body);
  return { status: res.status, body: await res.json() };
};

describe("hosted demo API (real library code, simulated Binance)", () => {
  it("scans 17 tokens, compares 12, and produces every classification", async () => {
    const { body } = await call("GET", "/api/opportunities", {}, `?notional=100&wallet=${DEMO_WALLET}&maxPairs=10`);
    expect(body.ok).toBe(true);
    const data = body.data;
    expect(data.assetsDiscovered).toBe(17);
    expect(data.opportunities).toHaveLength(12);
    const actions = new Set(data.opportunities.map((o: Opportunity) => o.action));
    expect([...actions].sort()).toEqual(["ACTIONABLE", "EXECUTABLE", "IGNORE", "WATCH"]);
    const nebl = data.opportunities.find((o: Opportunity) => o.asset.symbol === "NEBLon");
    expect(nebl.spreadPercent).toBeLessThan(-2);
    expect(nebl.action).toBe("EXECUTABLE");
    expect(Object.keys(data.attestations)).toHaveLength(12);
  });

  it("runs the full trade flow: simulate → PASSED → approve → simulated fill → wallet updated", async () => {
    const { body: scan } = await call("GET", "/api/opportunities", {}, `?notional=100&wallet=${DEMO_WALLET}`);
    const o = scan.data.opportunities.find((x: Opportunity) => x.asset.symbol === "NEBLon");
    const opportunity = JSON.stringify(o);
    const attestation = scan.data.attestations[o.asset.address];
    const sim = await call("POST", "/api/trade/simulate", { opportunity, attestation, wallet: DEMO_WALLET });
    expect(sim.body.data.status).toBe("PASSED");
    expect(sim.body.data.planToken).toBeTruthy();
    const before = demoState.usdt;
    const appr = await call("POST", "/api/trade/approve", { planToken: sim.body.data.planToken, wallet: DEMO_WALLET, confirm: true, preview: sim.body.data, opportunity, attestation });
    expect(appr.body.data).toMatchObject({ mode: "SIMULATED", result: "SIMULATED_FILL", authorization: { state: "USER_APPROVED", verdict: "AUTHORIZED" } });
    expect(appr.body.data.execution.txHash).toMatch(/^SIMULATED-/);
    expect(demoState.usdt).toBeLessThan(before);
    expect(demoState.holdings.NEBLon).toBeGreaterThan(0);
  });

  it("rejects tampered opportunities and approvals without confirmation", async () => {
    const { body: scan } = await call("GET", "/api/opportunities", {}, `?wallet=${DEMO_WALLET}`);
    const o = scan.data.opportunities[0];
    const attestation = scan.data.attestations[o.asset.address];
    const tampered = JSON.stringify({ ...o, spreadPercent: 9 });
    expect((await call("POST", "/api/trade/simulate", { opportunity: tampered, attestation, wallet: DEMO_WALLET })).status).toBe(400);
    expect((await call("POST", "/api/trade/approve", { confirm: false })).status).toBe(400);
  });

  it("compiles the spec strategy and runs an autonomous cycle on it", async () => {
    const text = "Buy tokenized stocks when they are at least 2% below reference price. Only trade when liquidity is above $100k. Maximum $50 per trade.";
    const parsed = await call("POST", "/api/strategy/parse", { text });
    expect(parsed.body.ok).toBe(true);
    const grant = await call("POST", "/api/autonomy/grant", { strategy: parsed.body.strategy, strategyName: "Buy 2% dips", maxTradeUsd: 25, maxTradesPerDay: 2, maxDailyUsd: 50, durationHours: 24, consent: true });
    expect(grant.body.ok).toBe(true);
    const run = await call("POST", "/api/autonomy/run", { grantToken: grant.body.data.grantToken, strategy: parsed.body.strategy, wallet: DEMO_WALLET });
    expect(run.body.data.candidates.map((c: { symbol: string }) => c.symbol)).toContain("NEBLon");
    expect(run.body.data.records[0]).toMatchObject({ mode: "SIMULATED", result: "SIMULATED_FILL" });
  });

  it("Weekend Mode flips with the simulated market", async () => {
    demoState.market = "OPEN";
    const { body } = await call("GET", "/api/opportunities", {}, `?wallet=${DEMO_WALLET}`);
    const open = body.data.opportunities.filter((o: Opportunity) => !o.marketStatus.isHardBlocked);
    expect(open.every((o: Opportunity) => o.marketStatus.openState === true)).toBe(true);
    demoState.market = "CLOSED";
  });
});
