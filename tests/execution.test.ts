import { describe, expect, it } from "vitest";
import { authorizeExecution, assertProof, buildExecutionRequest, createGrant, previewDigest, strategyHash, type AuthorizationContext } from "../src/lib/execution/policy";
import { InMemoryAuditLog, verifyChain, usageFrom } from "../src/lib/execution/audit";
import { MockExecutionProvider } from "../src/lib/execution/mock-provider";
import { BinanceAgenticWalletProvider, type CliRunner } from "../src/lib/execution/agentic-provider";
import { executeWithAuthorization, runAutonomousCycle } from "../src/lib/execution/runner";
import { rawToDecimalString, decimalStringToRaw } from "../src/lib/execution/units";
import type { Authorization, AuthorizationProof, ExecutionRequest } from "../src/lib/execution/types";
import { OpportunityScanner } from "../src/lib/engine/scanner";
import { buildTradePreview } from "../src/lib/trade/planner";
import { DEFAULT_USER_RULES } from "../src/lib/agent/types";
import type { Strategy } from "../src/lib/strategy/schema";
import type { Opportunity } from "../src/lib/engine/types";
import type { TradePreview } from "../src/lib/trade/types";
import { binanceBackend, E18, NOW, ONDO_TOKEN, USDT, WALLET } from "./fixtures/binance-backend";

/* Synthetic data only. XYZon trades at $99 vs XYZb at $100 per share (−1% discount). */
const STRATEGY: Strategy = {
  version: 1, action: "BUY", assetScope: { type: "ALL" }, spreadThresholdPercent: -0.75, minimumLiquidityUsd: 100_000,
  maximumTradeUsd: 50, maximumSlippagePercent: 0.5, marketStatus: "ANY", requireSimulation: true, sourceText: "test",
};
const grantFor = (over: Partial<Parameters<typeof createGrant>[0]> = {}) => {
  const g = createGrant({ strategy: STRATEGY, strategyName: "Buy XYZ dips", maxTradeUsd: 50, maxTradesPerDay: 3, maxDailyUsd: 150, durationMs: 86_400_000, provider: "mock", now: NOW, ...over });
  if (!g.ok) throw new Error(g.message);
  return g.grant;
};

async function passedPreview(notional = 50): Promise<{ preview: TradePreview; opportunity: Opportunity }> {
  const { client } = binanceBackend();
  const scan = await new OpportunityScanner(client, () => NOW).scan({ notional, wallet: WALLET, quoteTokenAddress: USDT });
  const opportunity = scan.opportunities.find((o) => o.asset.address === ONDO_TOKEN)!;
  const preview = await buildTradePreview({ client, opportunity, wallet: WALLET, rules: DEFAULT_USER_RULES, strategy: STRATEGY, quoteTokenAddress: USDT, now: () => NOW });
  return { preview, opportunity };
}

async function ctx(over: Partial<AuthorizationContext> = {}, auth?: Authorization | null): Promise<AuthorizationContext> {
  const { preview, opportunity } = await passedPreview();
  return {
    request: buildExecutionRequest(preview, opportunity),
    preview,
    opportunity,
    rules: DEFAULT_USER_RULES,
    strategy: STRATEGY,
    authorization: auth === undefined ? { type: "AUTONOMOUS_GRANT", grant: grantFor() } : auth,
    quoteTokenAddress: USDT,
    preflight: { ready: true, wallet: WALLET, quotaLeftUsd: null, detail: "ok" },
    usage: { tradesToday: 0, usdToday: 0, executedQuoteIds: new Set() },
    now: NOW + 1_000,
    ...over,
  };
}
const codes = (v: ReturnType<typeof authorizeExecution>) => (v.authorized ? [] : v.violations.map((x) => x.code));

describe("fixture sanity", () => {
  it("produces an EXECUTABLE discount and a PASSED simulation", async () => {
    const { preview, opportunity } = await passedPreview();
    expect(opportunity.action).toBe("EXECUTABLE");
    expect(preview.status).toBe("PASSED");
    expect(preview.input?.amount).toBe(50);
  });
});

describe("authorizeExecution: hard constraints", () => {
  it("authorizes a valid autonomous request and a valid user-approved request", async () => {
    expect((await ctx()).request).not.toBeNull();
    expect(authorizeExecution(await ctx()).authorized).toBe(true);
    expect(authorizeExecution(await ctx({}, { type: "USER_APPROVED", approvalId: "a", approvedAt: NOW })).authorized).toBe(true);
  });

  it("refuses with no authorization at all", async () => {
    expect(codes(authorizeExecution(await ctx({}, null)))).toContain("NO_AUTHORIZATION");
  });

  it("cannot increase the maximum trade size (grant can't exceed strategy; request can't exceed min of limits)", async () => {
    expect(createGrant({ strategy: STRATEGY, strategyName: "x", maxTradeUsd: 500, maxTradesPerDay: 1, maxDailyUsd: 500, durationMs: 3_600_000, provider: "mock", now: NOW }).ok).toBe(false);
    const c = await ctx();
    const inflated = { ...c.request!, input: { ...c.request!.input, usd: 51 } };
    expect(codes(authorizeExecution({ ...c, request: inflated }))).toContain("TRADE_SIZE_EXCEEDS_LIMIT");
    const smallerGrant = await ctx({}, { type: "AUTONOMOUS_GRANT", grant: grantFor({ maxTradeUsd: 20 }) });
    expect(codes(authorizeExecution(smallerGrant))).toContain("TRADE_SIZE_EXCEEDS_LIMIT");
    const v = authorizeExecution(smallerGrant);
    expect(v.limits.maxTradeUsd).toBe(20);
  });

  it("cannot bypass simulation", async () => {
    const c = await ctx();
    expect(codes(authorizeExecution({ ...c, preview: { ...c.preview, status: "UNVERIFIABLE" } }))).toContain("SIMULATION_NOT_PASSED");
    expect(codes(authorizeExecution({ ...c, request: null }))).toContain("SIMULATION_NOT_PASSED");
    const unsimulated = { ...c.preview, transactions: c.preview.transactions.map((t) => ({ ...t, simulation: null })) };
    expect(codes(authorizeExecution({ ...c, preview: unsimulated }))).toContain("SIMULATION_NOT_PASSED");
    expect(codes(authorizeExecution({ ...c, now: c.preview.expiresAt + 1 }))).toContain("PLAN_EXPIRED");
    const edited = { ...c.preview, minimumOutput: { ...c.preview.minimumOutput!, raw: "1" } };
    expect(codes(authorizeExecution({ ...c, preview: edited }))).toContain("SIMULATION_NOT_PASSED");
    // A request forged to match a non-PASSED preview (hash recomputed) is still refused on status alone.
    const notPassed = { ...c.preview, status: "UNVERIFIABLE" as const };
    const forged = { ...c.request!, previewHash: previewDigest(notPassed) };
    expect(codes(authorizeExecution({ ...c, preview: notPassed, request: forged }))).toEqual(["SIMULATION_NOT_PASSED"]);
  });

  it("cannot bypass slippage limits", async () => {
    const c = await ctx();
    expect(codes(authorizeExecution({ ...c, request: { ...c.request!, slippageLimitPercent: 5 } }))).toContain("SLIPPAGE_EXCEEDS_LIMIT");
    expect(codes(authorizeExecution({ ...c, preview: { ...c.preview, estimatedSlippagePercent: 0.9 }, request: c.request }))).toContain("SLIPPAGE_EXCEEDS_LIMIT");
    expect(codes(authorizeExecution({ ...c, request: { ...c.request!, output: { ...c.request!.output, minimumRaw: "0" } } }))).toContain("SLIPPAGE_EXCEEDS_LIMIT");
  });

  it("cannot trade unsupported assets", async () => {
    const c = await ctx();
    const badIssuer = { ...c.opportunity, asset: { ...c.opportunity.asset, issuer: "someissuer" } };
    expect(codes(authorizeExecution({ ...c, opportunity: badIssuer }))).toContain("UNSUPPORTED_ASSET");
    const otherToken = { ...c.request!, output: { ...c.request!.output, address: "0xdead000000000000000000000000000000000000" } };
    expect(codes(authorizeExecution({ ...c, request: otherToken }))).toContain("UNSUPPORTED_ASSET");
    expect(codes(authorizeExecution({ ...c, quoteTokenAddress: "0x1111111111111111111111111111111111111111" }))).toContain("UNSUPPORTED_ASSET");
    const tickerScope = { ...STRATEGY, assetScope: { type: "TICKERS" as const, tickers: ["TSLA"] } };
    expect(codes(authorizeExecution({ ...c, strategy: tickerScope }))).toContain("UNSUPPORTED_ASSET");
  });

  it("cannot use leverage or perps (non-spot request kinds are refused)", async () => {
    const c = await ctx();
    const perp = { ...c.request!, kind: "PERP_OPEN" as unknown as "SPOT_SWAP" };
    expect(codes(authorizeExecution({ ...c, request: perp }))).toContain("LEVERAGE_OR_DERIVATIVES");
  });

  it("cannot override wallet safety checks", async () => {
    const c = await ctx();
    expect(codes(authorizeExecution({ ...c, preflight: { ...c.preflight, wallet: "0x1234567890123456789012345678901234567890" } }))).toContain("WALLET_MISMATCH");
    const noBalance = { ...c.preview, steps: c.preview.steps.filter((s) => s.step !== "BALANCE") };
    expect(codes(authorizeExecution({ ...c, preview: noBalance }))).toContain("WALLET_SAFETY");
    const unlimited = { ...c.preview, transactions: c.preview.transactions.map((t) => ({ ...t, data: `0x095ea7b3${"0".repeat(24)}${"9".repeat(40)}${"f".repeat(64)}` })) };
    expect(codes(authorizeExecution({ ...c, preview: unlimited }))).toContain("WALLET_SAFETY");
    expect(codes(authorizeExecution({ ...c, preflight: { ...c.preflight, ready: false, detail: "locked" } }))).toContain("PROVIDER_NOT_READY");
    expect(codes(authorizeExecution({ ...c, preflight: { ...c.preflight, quotaLeftUsd: 10 } }))).toContain("PROVIDER_QUOTA");
  });

  it("enforces grant validity, strategy binding, daily caps and duplicates", async () => {
    const c = await ctx();
    expect(codes(authorizeExecution({ ...c, now: NOW + 2 * 86_400_000 }))).toContain("GRANT_EXPIRED");
    expect(codes(authorizeExecution({ ...c, strategy: { ...STRATEGY, maximumTradeUsd: 500 } }))).toContain("GRANT_INVALID");
    expect(codes(authorizeExecution({ ...c, usage: { tradesToday: 3, usdToday: 0, executedQuoteIds: new Set() } }))).toContain("DAILY_LIMIT");
    expect(codes(authorizeExecution({ ...c, usage: { tradesToday: 0, usdToday: 120, executedQuoteIds: new Set() } }))).toContain("DAILY_LIMIT");
    expect(codes(authorizeExecution({ ...c, usage: { tradesToday: 0, usdToday: 0, executedQuoteIds: new Set([c.preview.quoteId!]) } }))).toContain("DUPLICATE");
  });

  it("requires the agent to say EXECUTABLE for autonomous runs", async () => {
    const c = await ctx();
    const strict = { ...DEFAULT_USER_RULES, minNetEdgePercent: 5 };
    expect(codes(authorizeExecution({ ...c, rules: strict }))).toContain("AGENT_NOT_EXECUTABLE");
  });
});

describe("providers can't be called without an authorization proof", () => {
  it("assertProof rejects missing, mismatched and expired proofs", async () => {
    const c = await ctx();
    const r = c.request!;
    const proof: AuthorizationProof = { authorization: c.authorization!, requestId: r.requestId, previewHash: r.previewHash, authorizedAt: NOW, verdict: "AUTHORIZED" };
    expect(() => assertProof(r, null, NOW)).toThrow(/no authorization/);
    expect(() => assertProof(r, { ...proof, requestId: "other" }, NOW)).toThrow(/different request/);
    expect(() => assertProof(r, proof, r.expiresAt + 1)).toThrow(/expired/);
    await expect(new MockExecutionProvider().execute(r, { ...proof, previewHash: "x" })).rejects.toThrow();
  });
});

describe("MockExecutionProvider", () => {
  it("is clearly SIMULATED and never produces a 0x hash", async () => {
    const c = await ctx();
    const v = authorizeExecution(c);
    if (!v.authorized) throw new Error("expected authorized");
    const res = await new MockExecutionProvider({ now: () => NOW }).execute(c.request!, v.proof);
    expect(res).toMatchObject({ mode: "SIMULATED", provider: "mock", status: "FILLED", actualOutputRaw: c.request!.output.expectedRaw });
    expect(res.txHash).toMatch(/^SIMULATED-/);
    expect(res.txHash).not.toMatch(/^0x/);
  });
});

describe("BinanceAgenticWalletProvider (fake baw CLI; not a live test)", () => {
  type Reply = { data?: unknown; error?: string; raw?: string; exitCode?: number };
  function fakeCli(script: Record<string, Reply | Reply[]>) {
    const calls: string[][] = [];
    const run: CliRunner = async (args) => {
      calls.push(args);
      if (args[0] === "--version") return { stdout: "1.10.0\n", exitCode: 0 };
      const key = args.slice(0, 2).join(" ");
      const entry = script[key];
      const r = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
      if (!r) return { stdout: JSON.stringify({ success: false, error: { message: `no script for ${key}` } }), exitCode: 1 };
      if (r.raw !== undefined) return { stdout: r.raw, exitCode: r.exitCode ?? 0 };
      if (r.error) return { stdout: JSON.stringify({ success: false, error: { code: 1, name: "ERR", message: r.error } }), exitCode: 1 };
      return { stdout: JSON.stringify({ success: true, data: r.data }), exitCode: 0 };
    };
    return { run, calls };
  }
  const healthy = (over: Record<string, Reply | Reply[]> = {}) => ({
    "wallet status": { data: { status: "CONNECTED" } },
    "wallet address": { data: { addresses: [{ binanceChainId: "56", chainName: "BSC", address: WALLET }] } },
    "wallet tx-lock": { data: { status: "UNLOCKED" } },
    "wallet left-quota": { data: { quotaUsed: 0, quotaLeft: 500, dailyLimit: 500, date: "2027-01-15" } },
    "market-order quote": { data: { fromCoinAmount: "50", toCoinAmount: "0.505", slippage: 0.005 } },
    "market-order swap": { data: { orderId: "ord-1" } },
    "market-order list": [
      { data: { list: [{ orderId: "ord-1", status: "PENDING" }], total: 1 } },
      { data: { list: [{ orderId: "ord-1", status: "FINISHED", txHash: `0x${"ab".repeat(32)}`, toTokenActualQty: "0.5049" }], total: 1 } },
    ],
    ...over,
  });
  const provider = (run: CliRunner, extra = {}) => new BinanceAgenticWalletProvider({ run, versionPrefix: "1.10.", now: () => NOW + 1_000, sleep: async () => {}, pollTimeoutMs: 10_000, pollIntervalMs: 1, ...extra });
  const authorized = async () => {
    const c = await ctx({}, { type: "AUTONOMOUS_GRANT", grant: grantFor({ provider: "binance-agentic-wallet" }) });
    const v = authorizeExecution(c);
    if (!v.authorized) throw new Error(JSON.stringify(v.violations));
    return { request: c.request!, proof: v.proof };
  };

  it("preflight reads wallet, lock and quota; refuses on serverless, wrong version, disconnected or locked", async () => {
    expect(await provider(fakeCli(healthy()).run).preflight()).toMatchObject({ ready: true, wallet: WALLET, quotaLeftUsd: 500 });
    expect((await provider(fakeCli(healthy()).run, { isServerless: true }).preflight()).detail).toMatch(/local agent worker/);
    const oldVersion: CliRunner = async (a) => (a[0] === "--version" ? { stdout: "1.9.1", exitCode: 0 } : fakeCli(healthy()).run(a));
    expect((await provider(oldVersion).preflight()).ready).toBe(false);
    const missing: CliRunner = async () => ({ stdout: "", exitCode: 1 });
    expect((await provider(missing).preflight()).detail).toMatch(/isn't installed/);
    expect((await provider(fakeCli(healthy({ "wallet status": { data: { status: "UNCONNECTED" } } })).run).preflight()).detail).toMatch(/baw auth signin/);
    expect((await provider(fakeCli(healthy({ "wallet tx-lock": { data: { status: "LOCKED" } } })).run).preflight()).ready).toBe(false);
    expect((await provider(fakeCli(healthy({ "wallet status": { raw: "not json" } })).run).preflight()).ready).toBe(false);
  });

  it("executes with explicit slippage (never auto), exact decimal quantity, and --json; then verifies the fill", async () => {
    const { request, proof } = await authorized();
    const cli = fakeCli(healthy());
    const res = await provider(cli.run).execute(request, proof);
    expect(res).toMatchObject({ mode: "LIVE", status: "FILLED", orderId: "ord-1", txHash: `0x${"ab".repeat(32)}` });
    const swap = cli.calls.find((c) => c[1] === "swap")!;
    expect(swap).toEqual(["market-order", "swap", "--binanceChainId", "56", "--fromToken", USDT, "--toToken", ONDO_TOKEN, "--fromTokenQty", "50", "--slippage", "0.5", "--mev", "true", "--gasLevel", "MEDIUM", "--json"]);
    expect(swap).not.toContain("auto");
    expect(cli.calls.some((c) => c[0] === "wallet" && c[1] === "send")).toBe(false);
  });

  it("refuses a request whose proof doesn't match, before touching the CLI", async () => {
    const { request, proof } = await authorized();
    const cli = fakeCli(healthy());
    await expect(provider(cli.run).execute(request, { ...proof, requestId: "someone-else" })).rejects.toThrow(/different request/);
    await expect(provider(cli.run).execute(request, undefined as unknown as AuthorizationProof)).rejects.toThrow(/no authorization/);
    expect(cli.calls).toEqual([]);
  });

  it("refuses when baw's own route quotes below the simulated minimum (no swap sent)", async () => {
    const { request, proof } = await authorized();
    const cli = fakeCli(healthy({ "market-order quote": { data: { toCoinAmount: "0.1", slippage: 0.005 } } }));
    const res = await provider(cli.run).execute(request, proof);
    expect(res.status).toBe("FAILED");
    expect(res.detail).toMatch(/below the simulated minimum/);
    expect(cli.calls.some((c) => c[1] === "swap")).toBe(false);
  });

  it("refuses when baw applies more slippage than the limit", async () => {
    const { request, proof } = await authorized();
    const cli = fakeCli(healthy({ "market-order quote": { data: { toCoinAmount: "0.505", slippage: 0.03 } } }));
    expect((await provider(cli.run).execute(request, proof)).status).toBe("FAILED");
    expect(cli.calls.some((c) => c[1] === "swap")).toBe(false);
  });

  it("reports FILLED_BELOW_MINIMUM, FAILED orders, CLI errors and polling timeouts", async () => {
    const { request, proof } = await authorized();
    const below = fakeCli(healthy({ "market-order list": { data: { list: [{ orderId: "ord-1", status: "FINISHED", txHash: `0x${"cd".repeat(32)}`, toTokenActualQty: "0.0001" }] } } }));
    expect((await provider(below.run).execute(request, proof)).status).toBe("FILLED_BELOW_MINIMUM");
    const failed = fakeCli(healthy({ "market-order list": { data: { list: [{ orderId: "ord-1", status: "FAILED" }] } } }));
    expect((await provider(failed.run).execute(request, proof)).status).toBe("FAILED");
    const err = fakeCli(healthy({ "market-order swap": { error: "Insufficient balance" } }));
    expect((await provider(err.run).execute(request, proof)).detail).toMatch(/Insufficient balance/);
    let t = NOW;
    const pending = fakeCli(healthy({ "market-order list": { data: { list: [{ orderId: "ord-1", status: "PENDING" }] } } }));
    const slow = provider(pending.run, { now: () => (t += 5_000) - 4_000 });
    expect((await slow.execute(request, proof)).status).toBe("PENDING");
  });
});

describe("audit log", () => {
  it("chains records and detects tampering", async () => {
    const log = new InMemoryAuditLog();
    const c = await ctx();
    for (let i = 0; i < 3; i++) {
      await executeWithAuthorization({ provider: new MockExecutionProvider({ now: () => NOW }), preview: c.preview, opportunity: c.opportunity, rules: DEFAULT_USER_RULES, strategy: STRATEGY, strategyName: "s", authorization: c.authorization, quoteTokenAddress: USDT, audit: log, now: () => NOW + 1_000 });
    }
    const records = log.list();
    expect(verifyChain(records)).toEqual({ valid: true, brokenAt: null });
    const tampered = records.map((r, i) => (i === 1 ? { ...r, result: "FILLED" as const } : r));
    expect(verifyChain(tampered).valid).toBe(false);
    expect(verifyChain(records.filter((_, i) => i !== 1)).valid).toBe(false);
  });

  it("records every required field; the duplicate quote is refused and recorded", async () => {
    const log = new InMemoryAuditLog();
    const c = await ctx();
    const exec = () => executeWithAuthorization({ provider: new MockExecutionProvider({ now: () => NOW }), preview: c.preview, opportunity: c.opportunity, rules: DEFAULT_USER_RULES, strategy: STRATEGY, strategyName: "Buy XYZ dips", authorization: c.authorization, quoteTokenAddress: USDT, audit: log, now: () => NOW + 1_000 });
    const first = await exec();
    expect(first).toMatchObject({
      mode: "SIMULATED",
      result: "SIMULATED_FILL",
      asset: { symbol: "XYZon" },
      strategy: { name: "Buy XYZ dips", hash: strategyHash(STRATEGY) },
      signal: { direction: "DISCOUNT", agentDecision: "EXECUTABLE" },
      quote: { quoteId: c.preview.quoteId, inputUsd: 50 },
      simulation: { status: "PASSED" },
      authorization: { state: "AUTONOMOUS_GRANT", verdict: "AUTHORIZED" },
    });
    expect(first.timestamp).toBe(NOW + 1_000);
    expect(first.execution.txHash).toMatch(/^SIMULATED-/);
    const second = await exec();
    expect(second.result).toBe("REFUSED");
    expect(second.authorization.violations.map((v) => v.code)).toContain("DUPLICATE");
    expect(second.execution.status).toBe("NOT_ATTEMPTED");
    expect(usageFrom(log.list(), { now: NOW + 1_000 })).toMatchObject({ tradesToday: 1, usdToday: 50 });
  });
});

describe("autonomous cycles (end to end, fake Binance API)", () => {
  const cycle = (audit: InMemoryAuditLog, over: Partial<Parameters<typeof runAutonomousCycle>[0]> = {}) =>
    runAutonomousCycle({ client: binanceBackend().client, provider: new MockExecutionProvider({ wallet: WALLET, now: () => NOW }), grant: grantFor(), strategy: STRATEGY, strategyName: "Buy XYZ dips", rules: DEFAULT_USER_RULES, quoteTokenAddress: USDT, audit, now: () => NOW + 1_000, ...over });

  it("scan → strategy → agent → quote → build → simulate → authorize → simulated fill", async () => {
    const audit = new InMemoryAuditLog();
    const r = await cycle(audit);
    expect(r.candidates).toEqual([{ symbol: "XYZon", spreadPercent: -1 }]);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]).toMatchObject({ mode: "SIMULATED", result: "SIMULATED_FILL", quote: { inputUsd: 50 } });
  });

  it("stops at the grant's daily trade count", async () => {
    const audit = new InMemoryAuditLog();
    const { client } = binanceBackend(); // one backend: quote IDs stay unique across cycles, like the real API
    const grant = grantFor(); // one grant: daily usage is tracked per grant
    const results = [];
    for (let i = 0; i < 4; i++) results.push((await cycle(audit, { client, grant })).records[0]!.result);
    expect(results).toEqual(["SIMULATED_FILL", "SIMULATED_FILL", "SIMULATED_FILL", "REFUSED"]);
    expect(audit.list().at(-1)!.authorization.violations.map((v) => v.code)).toContain("DAILY_LIMIT");
    expect(verifyChain(audit.list()).valid).toBe(true);
  });

  it("a simulation failure is never executed", async () => {
    const audit = new InMemoryAuditLog();
    const r = await cycle(audit, { client: binanceBackend({ simulateStatus: "FAILED" }).client });
    expect(r.records[0]).toMatchObject({ result: "REFUSED", simulation: { status: "FAILED" } });
    expect(r.records[0]!.authorization.violations.map((v) => v.code)).toContain("SIMULATION_NOT_PASSED");
  });

  it("a swapped strategy breaks the grant binding", async () => {
    const audit = new InMemoryAuditLog();
    const r = await cycle(audit, { strategy: { ...STRATEGY, maximumSlippagePercent: 0.4 } });
    expect(r.records[0]!.authorization.violations.map((v) => v.code)).toContain("GRANT_INVALID");
  });

  it("no execution when nothing matches", async () => {
    const audit = new InMemoryAuditLog();
    const r = await cycle(audit, { strategy: { ...STRATEGY, spreadThresholdPercent: -5 }, grant: grantFor() });
    expect(r.records).toEqual([]);
    expect(r.note).toMatch(/No opportunity matches/);
  });

  it("runs LIVE through the Agentic Wallet adapter when authorized (fake CLI)", async () => {
    const run: CliRunner = async (args) => {
      if (args[0] === "--version") return { stdout: "1.10.0", exitCode: 0 };
      const k = args.slice(0, 2).join(" ");
      const data: Record<string, unknown> = {
        "wallet status": { status: "CONNECTED" },
        "wallet address": { addresses: [{ binanceChainId: "56", chainName: "BSC", address: WALLET }] },
        "wallet tx-lock": { status: "UNLOCKED" },
        "wallet left-quota": { quotaUsed: 0, quotaLeft: 500, dailyLimit: 500 },
        "market-order quote": { toCoinAmount: "0.505", slippage: 0.004 },
        "market-order swap": { orderId: "ord-9" },
        "market-order list": { list: [{ orderId: "ord-9", status: "FINISHED", txHash: `0x${"ef".repeat(32)}`, toTokenActualQty: "0.5049" }] },
      };
      return { stdout: JSON.stringify({ success: true, data: data[k] }), exitCode: 0 };
    };
    const audit = new InMemoryAuditLog();
    const r = await cycle(audit, {
      provider: new BinanceAgenticWalletProvider({ run, versionPrefix: "1.10.", now: () => NOW + 1_000, sleep: async () => {} }),
      grant: grantFor({ provider: "binance-agentic-wallet" }),
    });
    expect(r.records[0]).toMatchObject({ mode: "LIVE", provider: "binance-agentic-wallet", result: "FILLED", execution: { txHash: `0x${"ef".repeat(32)}` } });
  });
});

describe("units", () => {
  it("converts exactly in both directions", () => {
    expect(rawToDecimalString((50n * E18).toString(), 18)).toBe("50");
    expect(rawToDecimalString("1500000", 6)).toBe("1.5");
    expect(rawToDecimalString("1", 18)).toBe("0.000000000000000001");
    expect(decimalStringToRaw("0.5049", 18)).toBe(504_900_000_000_000_000n);
    expect(decimalStringToRaw("1.23456789", 6)).toBe(1_234_567n);
    expect(decimalStringToRaw("-1", 18)).toBeNull();
  });
});

describe("module boundaries", () => {
  it("the web app never constructs a live CLI runner", async () => {
    const { readFileSync } = await import("node:fs");
    const server = readFileSync(new URL("../src/lib/execution/server.ts", import.meta.url), "utf8");
    expect(server).not.toMatch(/nodeCliRunner|child_process/);
    expect(server).toMatch(/isServerless: true/);
  });
  it("execution code never transfers or sends tokens", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../src/lib/execution/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src).not.toMatch(/"wallet",\s*"send"|wallet send"|limit-order|eth_sendTransaction|privateKey/);
    }
  });
});
