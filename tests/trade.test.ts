import { describe, expect, it } from "vitest";
import { buildTradePreview } from "../src/lib/trade/planner";
import { approvePlan, attachPlanToken } from "../src/lib/trade/approval";
import { decodeApprove, MAX_UINT256 } from "../src/lib/trade/calldata";
import { inspectTypedData } from "../src/lib/trade/typed-data";
import { evaluateOpportunity } from "../src/lib/engine/evaluate";
import { numberToRawCeil } from "../src/lib/engine/calculations";
import { DEFAULT_USER_RULES } from "../src/lib/agent/types";
import type { Opportunity } from "../src/lib/engine/types";
import { apiClient, envelope, fakeFetch, json } from "./helpers";

/* Synthetic addresses and prices for tests only. Not real tokens or market data. */
const NOW = 1_800_000_000_000;
const E18 = 10n ** 18n;
const WALLET = "0x7000000000000000000000000000000000000007";
const TOKEN = "0xa000000000000000000000000000000000000001";
const USDT = "0x5000000000000000000000000000000000000005";
const SPENDER = "0x9000000000000000000000000000000000000009";
const ROUTER = "0x8000000000000000000000000000000000000008";
const SECRET = "test-plan-secret";
const LIMITS = { rules: DEFAULT_USER_RULES, strategy: null };

/** Test-only encoder for approve(spender, amount). Production code never encodes calldata. */
const encodeApprove = (spender: string, amount: bigint) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

/** Engine-EXECUTABLE discount: token $99 vs reference $100, wallet holds $1,000 USDT. */
function buyOpportunity(over: Partial<Parameters<typeof evaluateOpportunity>[0]> = {}): Opportunity {
  const notional = 250;
  return evaluateOpportunity({
    asset: { address: TOKEN, issuer: "ondo", symbol: "XYZon", underlyingTicker: "XYZ", decimals: 18, tokenToShareRatio: 1 },
    onChain: { tokenPriceUsd: 99, updatedAt: NOW - 5_000 },
    reference: { kind: "CROSS_ISSUER", perSharePriceUsd: 100, asOf: NOW - 5_000, source: "bstock:XYZb" },
    market: { available: true, openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null, nextOpenTime: null, nextCloseTime: null, isHardBlocked: false },
    liquidity: { totalUsd: 1_000_000, poolCount: 2 },
    notional,
    quote: {
      side: "BUY_TOKEN", fromAmountRaw: (250n * E18).toString(), fromDecimals: 18,
      toAmountRaw: numberToRawCeil((notional / 99) * 0.998, 18)!.toString(), toDecimals: 18,
      stableUnitPriceUsd: 1, priceImpactPercent: 0.2, tradeFeeUsd: 0.04, taxRate: 0, isHoneyPot: false,
      executionMode: "RFQ", vendorName: "PcsXRfq", quoteId: "scan-quote", fetchedAt: NOW - 3_000,
    },
    wallet: { address: WALLET, tokenBalanceRaw: "0", tokenDecimals: 18, stableBalanceRaw: (1_000n * E18).toString(), stableDecimals: 18, fetchedAt: NOW },
    now: NOW,
    ...over,
  });
}

const AMOUNT = 250n * E18;
const EXPECTED_OUT = numberToRawCeil((250 / 99) * 0.998, 18)!;

interface Backend {
  mode?: "RFQ" | "SWAP";
  approveTarget?: string | null;
  approveAmount?: bigint;
  stableBalance?: bigint;
  toAmount?: bigint;
  typedData?: string | object;
  swapTx?: Record<string, unknown>;
  simulate?: (to: string) => Record<string, unknown>;
  quoteFails?: boolean;
}

/** Fake Binance Web3 API. Records every path so tests can prove nothing is submitted. */
function backend(b: Backend = {}) {
  const mode = b.mode ?? "RFQ";
  const toAmount = b.toAmount ?? EXPECTED_OUT;
  const approveTarget = b.approveTarget === undefined ? SPENDER : b.approveTarget;
  const paths: string[] = [];
  const typed =
    b.typedData ??
    { domain: { name: "PcsXRfq", chainId: 56 }, primaryType: "Order", message: { receiver: WALLET, sellAmount: AMOUNT.toString(), buyAmount: toAmount.toString(), deadline: Math.floor(NOW / 1000) + 120 } };
  const f = fakeFetch((url, init) => {
    const p = url.pathname.replace("/build/api/v1/dex", "");
    paths.push(p);
    const ok = (d: unknown) => json(200, envelope(d))(url, init);
    if (p === "/market/token/basic-info") return ok({ decimals: 18, tokenSymbol: "USDT" });
    if (p === "/balance/token-balances-by-address") return ok([{ tokenAssets: [{ tokenContractAddress: USDT, rawBalance: (b.stableBalance ?? 1_000n * E18).toString() }] }]);
    if (p === "/aggregator/quote") {
      if (b.quoteFails) return json(200, { code: 40001, msg: "PARAM_ERROR" })(url, init);
      return ok([{
        quoteId: "fresh-quote", vendorName: "PcsXRfq", executionMode: mode, isBest: true, approveTarget,
        fromTokenAmount: url.searchParams.get("amount"), toTokenAmount: toAmount.toString(),
        tradeFee: "0.04", estimateGasFee: "100000000000000", priceImpactPercent: "0.2",
        fromToken: { tokenContractAddress: USDT, decimal: "18", tokenUnitPrice: "1" },
        toToken: { tokenContractAddress: TOKEN, decimal: "18" },
        dexRouterList: [{ dexProtocol: { dexName: "PancakeSwap RFQ", percent: "100" } }],
      }]);
    }
    if (p === "/aggregator/approve-transaction") {
      return ok([{ data: encodeApprove(SPENDER, b.approveAmount ?? AMOUNT), dexContractAddress: SPENDER, gasLimit: "50000", gasPrice: "1000000000" }]);
    }
    if (p === "/aggregator/swap") {
      if (mode === "RFQ") return ok({ executionMode: "RFQ", rfq: { vendor: "PcsXRfq", txType: "EIP712", typedDataToSign: typeof typed === "string" ? typed : JSON.stringify(typed) } });
      return ok({ executionMode: "SWAP", tx: { from: WALLET, to: ROUTER, data: "0xabcdef", value: "0", gas: "200000", minReceiveAmount: ((toAmount * 9950n) / 10000n).toString(), ...b.swapTx } });
    }
    if (p === "/pre-transaction/gas-price") return ok({ evmLegacyGasPrice: { mediumGasPrice: "1000000000" } });
    if (p === "/pre-transaction/simulate") {
      const to = JSON.parse(String(init.body)).evmTx.to as string;
      if (b.simulate) return ok(b.simulate(to));
      if (to.toLowerCase() === USDT) {
        return ok({ status: "SUCCESS", allowanceChanges: [{ tokenAddress: USDT, owner: WALLET, spender: SPENDER, preAmount: "0", postAmount: (b.approveAmount ?? AMOUNT).toString() }] });
      }
      return ok({ status: "SUCCESS", balanceChanges: [
        { owner: WALLET, contractAddress: USDT, change: `-${AMOUNT}` },
        { owner: WALLET, contractAddress: TOKEN, change: toAmount.toString() },
      ] });
    }
    throw new Error(`unexpected ${p}`);
  });
  return { client: apiClient(f.impl, { maxRetries: 0 }), paths };
}

const run = (b: Backend = {}, over: Partial<Parameters<typeof buildTradePreview>[0]> = {}) => {
  const be = backend(b);
  return buildTradePreview({ client: be.client, opportunity: buyOpportunity(), wallet: WALLET, rules: DEFAULT_USER_RULES, quoteTokenAddress: USDT, now: () => NOW, ...over }).then((p) => ({ p, paths: be.paths }));
};

const NEVER_CALLED = ["/aggregator/order/submit", "/pre-transaction/broadcast-transaction"];

describe("PASSED: RFQ buy with a first-time approval", () => {
  it("simulates the approval, verifies the order, and shows every required field", async () => {
    const { p, paths } = await run();
    expect(p.status).toBe("PASSED");
    expect(p.headline).toBe("Simulation passed.");
    expect(p.input).toMatchObject({ symbol: "USDT", address: USDT, amount: 250, usd: 250 });
    expect(p.expectedOutput).toMatchObject({ symbol: "XYZon", address: TOKEN });
    expect(p.expectedOutput!.usd).toBeCloseTo(249.5, 1);
    expect(p.minimumOutput).toMatchObject({ source: "TYPED_DATA", raw: EXPECTED_OUT.toString() });
    expect(p.priceImpactPercent).toBe(0.2);
    expect(p.estimatedSlippagePercent).toBeCloseTo(0.2, 3);
    expect(p.gas.totalBnb).toBeCloseTo(0.00005, 10); // 50,000 gas × 1 gwei
    expect(p.gas.totalUsd).toBeCloseTo(0.02, 6); // implied $400/BNB from the quote's own fee figures
    expect(p.route).toEqual({ vendor: "PcsXRfq", executionMode: "RFQ", hops: [{ dex: "PancakeSwap RFQ", percent: "100" }] });
    expect(p.net.vsReferencePercent).toBeGreaterThan(0.5);
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0]).toMatchObject({ kind: "APPROVE", to: USDT, value: "0", simulation: { passed: true } });
    expect(p.transactions[0]!.checks.every((c) => c.passed)).toBe(true);
    expect(p.rfqOrder?.checks.every((c) => c.passed)).toBe(true);
    expect(p.steps.map((s) => [s.step, s.status])).toEqual([["STRATEGY", "ok"], ["BALANCE", "ok"], ["QUOTE", "ok"], ["EXPECTED_OUTPUT", "ok"], ["BUILD", "ok"], ["SIMULATION", "ok"]]);
    expect(p.expiresAt).toBe(NOW + 30_000);
    for (const bad of NEVER_CALLED) expect(paths).not.toContain(bad);
    expect(paths).toContain("/pre-transaction/simulate");
  });

  it("requests an exact-amount approval and never unlimited", async () => {
    const { p } = await run();
    expect(decodeApprove(p.transactions[0]!.data)!.amount).toBe(AMOUNT);
  });
});

describe("FAILED: never executable, reason shown", () => {
  it("approval simulation fails → FAILED with the simulator's reason", async () => {
    const { p } = await run({ simulate: () => ({ status: "FAILED", failReason: "execution reverted: token paused" }) });
    expect(p.status).toBe("FAILED");
    expect(p.failureReason).toBe("execution reverted: token paused");
  });

  it("an unlimited approval from the API is refused", async () => {
    const { p } = await run({ approveAmount: MAX_UINT256 });
    expect(p.status).toBe("FAILED");
    expect(p.failureReason).toMatch(/Unlimited approval/);
  });

  it("an RFQ order paying someone else is refused", async () => {
    const { p } = await run({ typedData: { domain: { chainId: 56 }, primaryType: "Order", message: { receiver: SPENDER, sellAmount: AMOUNT.toString(), buyAmount: EXPECTED_OUT.toString() } } });
    expect(p.status).toBe("FAILED");
    expect(p.failureReason).toMatch(/not your wallet/);
  });

  it("an RFQ order paying less than the slippage floor is refused", async () => {
    const { p } = await run({ typedData: { domain: { chainId: 56 }, primaryType: "Order", message: { receiver: WALLET, sellAmount: AMOUNT.toString(), buyAmount: "1" } } });
    expect(p.status).toBe("FAILED");
    expect(p.failureReason).toMatch(/below your slippage floor/);
  });

  it("a simulated allowance that doesn't match is refused", async () => {
    const { p } = await run({ simulate: () => ({ status: "SUCCESS", allowanceChanges: [{ tokenAddress: USDT, owner: WALLET, spender: ROUTER, postAmount: AMOUNT.toString() }] }) });
    expect(p.status).toBe("FAILED");
  });
});

describe("SWAP routes", () => {
  it("no approval needed → swap simulated, balance changes verified → PASSED", async () => {
    const { p } = await run({ mode: "SWAP", approveTarget: null });
    expect(p.status).toBe("PASSED");
    expect(p.transactions.map((t) => t.kind)).toEqual(["SWAP"]);
    expect(p.minimumOutput?.source).toBe("TRANSACTION");
    expect(p.transactions[0]!.checks.map((c) => c.check)).toEqual(["SENDER", "NATIVE_VALUE", "MIN_RECEIVE", "SIM_SPEND", "SIM_RECEIVE"]);
  });

  it("simulated output below the minimum → FAILED", async () => {
    const { p } = await run({ mode: "SWAP", approveTarget: null, simulate: () => ({ status: "SUCCESS", balanceChanges: [{ owner: WALLET, contractAddress: USDT, change: `-${AMOUNT}` }, { owner: WALLET, contractAddress: TOKEN, change: "1" }] }) });
    expect(p.status).toBe("FAILED");
  });

  it("a swap that would also send BNB → FAILED", async () => {
    const { p } = await run({ mode: "SWAP", approveTarget: null, swapTx: { value: "1000" } });
    expect(p.status).toBe("FAILED");
    expect(p.failureReason).toMatch(/BNB/);
  });

  it("swap from a different sender → FAILED", async () => {
    const { p } = await run({ mode: "SWAP", approveTarget: null, swapTx: { from: SPENDER } });
    expect(p.status).toBe("FAILED");
  });

  it("approval needed first → APPROVAL_REQUIRED, swap not simulated, no plan", async () => {
    const { p, paths } = await run({ mode: "SWAP" });
    expect(p.status).toBe("APPROVAL_REQUIRED");
    expect(paths.filter((x) => x === "/pre-transaction/simulate")).toHaveLength(1);
    expect(attachPlanToken(p, SECRET, LIMITS).planToken).toBeNull();
  });
});

describe("UNVERIFIABLE: no confirmation without a simulation", () => {
  it("RFQ with an existing allowance has nothing to simulate", async () => {
    const { p, paths } = await run({ approveTarget: null });
    expect(p.status).toBe("UNVERIFIABLE");
    expect(paths).not.toContain("/pre-transaction/simulate");
    expect(attachPlanToken(p, SECRET, LIMITS).planToken).toBeNull();
  });

  it("hex-encoded typed data can't be verified", async () => {
    const { p } = await run({ typedData: "0xdeadbeef" });
    expect(p.status).toBe("UNVERIFIABLE");
  });
});

describe("BLOCKED before anything is built", () => {
  it("agent not EXECUTABLE (premium with no tokens held)", async () => {
    const o = buyOpportunity({ onChain: { tokenPriceUsd: 101, updatedAt: NOW - 5_000 } });
    const { p, paths } = await run({}, { opportunity: o });
    expect(p.status).toBe("BLOCKED");
    expect(p.steps[0]).toMatchObject({ step: "STRATEGY", status: "failed" });
    expect(paths).toEqual([]);
  });

  it("insufficient balance", async () => {
    const { p, paths } = await run({ stableBalance: 10n * E18 });
    expect(p.status).toBe("BLOCKED");
    expect(p.failureReason).toMatch(/needs 250/);
    expect(paths).not.toContain("/aggregator/quote");
  });

  it("fresh quote slippage above the limit", async () => {
    const { p } = await run({ toAmount: (EXPECTED_OUT * 97n) / 100n });
    expect(p.status).toBe("BLOCKED");
    expect(p.failureReason).toMatch(/above your 0.50% limit/);
  });

  it("quote error", async () => {
    const { p } = await run({ quoteFails: true });
    expect(p.status).toBe("BLOCKED");
    expect(p.failureReason).toMatch(/PARAM_ERROR/);
  });

  it("selected strategy doesn't match", async () => {
    const strategy = { version: 1 as const, action: "BUY" as const, assetScope: { type: "ALL" as const }, spreadThresholdPercent: -5, minimumLiquidityUsd: 100_000, maximumTradeUsd: 50, maximumSlippagePercent: 0.5, marketStatus: "ANY" as const, requireSimulation: true as const, sourceText: "x" };
    const { p } = await run({}, { strategy });
    expect(p.status).toBe("BLOCKED");
    expect(p.failureReason).toMatch(/strategy doesn't match/);
  });

  it("a matching strategy caps the trade size", async () => {
    const strategy = { version: 1 as const, action: "BUY" as const, assetScope: { type: "ALL" as const }, spreadThresholdPercent: -0.5, minimumLiquidityUsd: 100_000, maximumTradeUsd: 50, maximumSlippagePercent: 0.4, marketStatus: "ANY" as const, requireSimulation: true as const, sourceText: "x" };
    const be = backend({ approveAmount: 50n * E18, simulate: () => ({ status: "SUCCESS" }) });
    const p = await buildTradePreview({ client: be.client, opportunity: buyOpportunity(), wallet: WALLET, rules: DEFAULT_USER_RULES, strategy, quoteTokenAddress: USDT, now: () => NOW });
    expect(p.input?.amount).toBe(50);
    expect(p.slippageLimitPercent).toBe(0.4);
  });
});

describe("explicit approval", () => {
  const passed = async () => attachPlanToken((await run()).p, SECRET, LIMITS);

  it("issues a plan token only for PASSED previews", async () => {
    expect((await passed()).planToken).toMatch(/^[\w-]+\.[\w-]+$/);
  });

  it("approves only with confirm === true, a valid token, the same wallet, before expiry", async () => {
    const p = await passed();
    const ok = approvePlan({ planToken: p.planToken!, confirm: true, wallet: WALLET, secret: SECRET, now: NOW + 1_000 });
    expect(ok.ok).toBe(true);
    expect(approvePlan({ planToken: p.planToken!, confirm: "yes", wallet: WALLET, secret: SECRET, now: NOW })).toMatchObject({ ok: false, reason: "not_confirmed" });
    expect(approvePlan({ planToken: p.planToken!, confirm: true, wallet: WALLET, secret: SECRET, now: NOW + 31_000 })).toMatchObject({ ok: false, reason: "expired" });
    expect(approvePlan({ planToken: p.planToken!, confirm: true, wallet: SPENDER, secret: SECRET, now: NOW })).toMatchObject({ ok: false, reason: "wallet_mismatch" });
    const [body, sig] = p.planToken!.split(".");
    const forged = `${Buffer.from(Buffer.from(body!, "base64url").toString().replace(/"inputRaw":"\d+"/, '"inputRaw":"1"')).toString("base64url")}.${sig}`;
    expect(approvePlan({ planToken: forged, confirm: true, wallet: WALLET, secret: SECRET, now: NOW })).toMatchObject({ ok: false, reason: "invalid_token" });
  });

  it("binds the simulated limits and rejects an edited preview", async () => {
    const p = await passed();
    const ok = approvePlan({ planToken: p.planToken!, confirm: true, wallet: WALLET, secret: SECRET, now: NOW, preview: p });
    expect(ok.ok && ok.approval.claims.rules).toEqual(DEFAULT_USER_RULES);
    const edited = { ...p, input: { ...p.input!, amount: 9999 } };
    expect(approvePlan({ planToken: p.planToken!, confirm: true, wallet: WALLET, secret: SECRET, now: NOW, preview: edited })).toMatchObject({ ok: false, reason: "preview_mismatch" });
  });
});

describe("calldata and typed-data helpers", () => {
  it("decodes approve() and rejects other calldata", () => {
    expect(decodeApprove(encodeApprove(SPENDER, 5n))).toEqual({ spender: SPENDER, amount: 5n });
    expect(decodeApprove("0xa9059cbb" + "0".repeat(128))).toBeNull(); // transfer()
    expect(decodeApprove("0x095ea7b3")).toBeNull();
  });

  it("flags wrong chain, past deadline, and missing amounts", () => {
    const r = inspectTypedData(JSON.stringify({ domain: { chainId: 1 }, message: { receiver: WALLET, validTo: Math.floor(NOW / 1000) - 10 } }), { wallet: WALLET, sellAmountRaw: "1", minBuyAmountRaw: 1n, now: NOW });
    const failed = r.checks.filter((c) => !c.passed).map((c) => c.check);
    expect(failed).toEqual(["CHAIN", "SELL_AMOUNT", "BUY_AMOUNT", "DEADLINE"]);
  });
});

describe("module boundary", () => {
  it("the trade module never references order submission, broadcast or signing", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../src/lib/trade/", import.meta.url);
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      // Code identifiers and endpoints, not prose (doc comments say "never broadcasts").
      expect(src).not.toMatch(/submitRfqOrder|order\/submit|broadcastTransaction|broadcast-transaction|eth_sendTransaction|eth_sendRawTransaction|eth_signTypedData|privateKey/);
    }
  });
});
