/**
 * Trade preview planner.
 *
 *   Opportunity → strategy/rules gate → balance → Trading API quote → expected output
 *   → transaction construction (Binance-built) → Transaction API simulation → preview
 *
 * Read-only. It builds and SIMULATES; it never signs, submits or broadcasts.
 * Every transaction comes from Binance's /approve-transaction or /swap; GapPilot
 * only decodes and checks them.
 */
import type { BinanceWeb3Client } from "../binance/facade";
import { BinanceApiError } from "../binance/errors";
import type { QuoteRoute, SimulationResult } from "../binance/types";
import { runAgentDeterministic } from "../agent/deterministic";
import type { UserRules } from "../agent/types";
import { calculateNetOpportunity, estimateSlippage, rawToNumber } from "../engine/calculations";
import { quoteFromRoute, selectBestRoute } from "../engine/adapters";
import { DISCLAIMER, type Opportunity } from "../engine/types";
import { matchStrategy } from "../strategy/match";
import { StrategySchema, type Strategy } from "../strategy/schema";
import { decodeApprove, MAX_UINT256, sameAddress } from "./calldata";
import { inspectTypedData } from "./typed-data";
import type { PreviewStatus, SimulatedTx, StepResult, TokenAmount, TradePreview } from "./types";

const BSC = "56";
/** Spec: quoteId TTL ≈ 30 s. Approval must happen inside this window. */
export const QUOTE_TTL_MS = 30_000;

export interface PlannerInput {
  client: BinanceWeb3Client;
  opportunity: Opportunity;
  wallet: string;
  rules: UserRules;
  strategy?: Strategy | null;
  quoteTokenAddress: string;
  now?: () => number;
}

/** Floor conversion: never request more than the user's limit. */
function toRawFloor(value: number, decimals: number): bigint | null {
  if (!Number.isFinite(value) || value <= 0 || value >= 1e21) return null;
  const [w, f = ""] = value.toFixed(Math.min(decimals, 100)).split(".");
  return BigInt(w! + f.padEnd(decimals, "0").slice(0, decimals));
}

const okStatus = (s: SimulationResult | null | undefined) => (s?.status ?? "").toUpperCase() === "SUCCESS";

function errText(e: unknown): string {
  if (e instanceof BinanceApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export async function buildTradePreview(input: PlannerInput): Promise<TradePreview> {
  const { client, opportunity: o, wallet, rules } = input;
  const now = input.now ?? Date.now;
  const createdAt = now();
  const steps: StepResult[] = [];
  const warnings: string[] = [];
  const side: "BUY" | "SELL" = o.spotAction === "SELL_TOKEN" ? "SELL" : "BUY";

  const preview: TradePreview = {
    status: "BLOCKED",
    headline: "",
    failureReason: null,
    steps,
    side,
    wallet,
    input: null,
    expectedOutput: null,
    minimumOutput: null,
    priceImpactPercent: null,
    estimatedSlippagePercent: null,
    slippageLimitPercent: rules.maxSlippagePercent,
    gas: { totalBnb: null, totalUsd: null, note: "" },
    route: { vendor: null, executionMode: null, hops: [] },
    net: { vsMarketUsd: null, vsReferenceUsd: null, vsReferencePercent: null },
    transactions: [],
    rfqOrder: null,
    warnings,
    quoteId: null,
    createdAt,
    expiresAt: createdAt,
    planToken: null,
    disclaimer: DISCLAIMER,
  };

  const finish = (status: PreviewStatus, headline: string, failureReason: string | null = null): TradePreview => {
    preview.status = status;
    preview.headline = headline;
    preview.failureReason = failureReason;
    return preview;
  };
  const block = (step: StepResult["step"], reason: string) => {
    steps.push({ step, status: "failed", detail: reason });
    return finish("BLOCKED", "This trade was not simulated.", reason);
  };

  // ── 1. Strategy & rules ───────────────────────────────────────────────────
  if (o.spotAction === "NONE") return block("STRATEGY", "There is no spread to act on.");
  const agent = runAgentDeterministic(o, rules);
  if (agent.decision !== "EXECUTABLE") {
    return block("STRATEGY", `The agent's recommendation is ${agent.recommendedAction.replace("_", " ").toLowerCase()} (${agent.decision.toLowerCase()}): ${agent.summary}`);
  }
  let strategy: Strategy | null = null;
  if (input.strategy) {
    const parsed = StrategySchema.safeParse(input.strategy);
    if (!parsed.success) return block("STRATEGY", "The selected strategy is invalid.");
    strategy = parsed.data;
    const m = matchStrategy(strategy, o);
    if (!m.matches) return block("STRATEGY", `The selected strategy doesn't match: ${m.unmet.join("; ")}.`);
    if ((strategy.action === "BUY") !== (side === "BUY")) return block("STRATEGY", "The strategy's action doesn't match this trade's direction.");
  }
  const notional = Math.min(o.notional, rules.maxNotionalUsd, strategy?.maximumTradeUsd ?? Infinity);
  const slippageLimit = Math.min(rules.maxSlippagePercent, strategy?.maximumSlippagePercent ?? Infinity);
  preview.slippageLimitPercent = slippageLimit;
  steps.push({
    step: "STRATEGY",
    status: "ok",
    detail: `Agent: executable under your rules${strategy ? "; the selected strategy matches" : ""}. Size $${notional.toFixed(2)}, slippage limit ${slippageLimit.toFixed(2)}%.`,
  });

  // ── 2. Token setup & balance ──────────────────────────────────────────────
  let stableDecimals: number;
  let stableSymbol = "USDT";
  try {
    const { data } = await client.market.basicInfo({ binanceChainId: BSC, tokenContractAddress: input.quoteTokenAddress });
    if (typeof data?.decimals !== "number") return block("BALANCE", "Stablecoin decimals are unavailable from the Market API.");
    stableDecimals = data.decimals;
    stableSymbol = data.tokenSymbol ?? stableSymbol;
  } catch (e) {
    return block("BALANCE", `Couldn't read stablecoin details: ${errText(e)}`);
  }

  const asset = { address: o.asset.address, symbol: o.asset.symbol, decimals: o.asset.decimals };
  const stable = { address: input.quoteTokenAddress, symbol: stableSymbol, decimals: stableDecimals };
  const from = side === "BUY" ? stable : asset;
  const to = side === "BUY" ? asset : stable;
  const amountRaw = side === "BUY" ? toRawFloor(notional, stableDecimals) : toRawFloor(notional / o.onChainTokenPrice, asset.decimals);
  if (!amountRaw || amountRaw <= 0n) return block("BALANCE", "The trade size rounds to zero.");

  try {
    const { data } = await client.wallet.tokenBalances({ address: wallet, tokenContractAddresses: [{ binanceChainId: BSC, tokenContractAddress: from.address }] });
    const entry = (data ?? []).flatMap((r) => r.tokenAssets ?? []).find((a) => sameAddress(a.tokenContractAddress, from.address));
    const have = entry?.rawBalance && /^\d+$/.test(entry.rawBalance) ? BigInt(entry.rawBalance) : 0n;
    if (have < amountRaw) {
      return block("BALANCE", `Your wallet holds ${rawToNumber(have.toString(), from.decimals)} ${from.symbol}; this trade needs ${rawToNumber(amountRaw.toString(), from.decimals)}.`);
    }
    steps.push({ step: "BALANCE", status: "ok", detail: `Wallet holds enough ${from.symbol}.` });
  } catch (e) {
    return block("BALANCE", `Couldn't read your balance: ${errText(e)}`);
  }

  // ── 3. Quote ──────────────────────────────────────────────────────────────
  let route: QuoteRoute | null;
  const quotedAt = now();
  try {
    const { data } = await client.trading.quote({
      binanceChainId: BSC,
      amount: amountRaw.toString(),
      fromTokenAddress: from.address,
      toTokenAddress: to.address,
      userWalletAddress: wallet,
    });
    route = selectBestRoute(data);
  } catch (e) {
    return block("QUOTE", `The Trading API didn't return a quote: ${errText(e)}`);
  }
  const quote = route ? quoteFromRoute(route, side === "BUY" ? "BUY_TOKEN" : "SELL_TOKEN", quotedAt, { from: from.decimals, to: to.decimals }) : null;
  if (!route || !quote || !route.quoteId) return block("QUOTE", "No usable route was returned for this trade.");
  if (quote.isHoneyPot) return block("QUOTE", "The quote flags this token as potentially unsellable.");
  preview.quoteId = route.quoteId;
  preview.expiresAt = quotedAt + QUOTE_TTL_MS;
  preview.route = {
    vendor: route.vendorName ?? null,
    executionMode: route.executionMode ?? null,
    hops: (route.dexRouterList ?? []).map((h) => ({ dex: h.dexProtocol?.dexName ?? "unknown", percent: h.dexProtocol?.percent ?? null })),
  };
  preview.priceImpactPercent = quote.priceImpactPercent;
  steps.push({ step: "QUOTE", status: "ok", detail: `${route.vendorName ?? "Aggregator"} quote, ${route.executionMode ?? "mode unknown"} execution.` });

  // ── 4. Expected output & economics (fresh) ────────────────────────────────
  const stablePrice = quote.stableUnitPriceUsd;
  const tokenAmt = (t: typeof from, raw: string, usdPerUnit: number | null): TokenAmount => {
    const amount = rawToNumber(raw, t.decimals) ?? 0;
    return { symbol: t.symbol, address: t.address, decimals: t.decimals, raw, amount, usd: usdPerUnit !== null ? amount * usdPerUnit : null };
  };
  const tokenUsd = o.onChainTokenPrice;
  preview.input = tokenAmt(from, quote.fromAmountRaw, side === "BUY" ? stablePrice : tokenUsd);
  preview.expectedOutput = tokenAmt(to, quote.toAmountRaw, side === "BUY" ? tokenUsd : stablePrice);

  const slip = estimateSlippage(quote, tokenUsd);
  preview.estimatedSlippagePercent = slip?.percent ?? null;
  if (!slip) return block("EXPECTED_OUTPUT", "Slippage couldn't be estimated from the quote.");
  if (slip.percent > slippageLimit) return block("EXPECTED_OUTPUT", `The fresh quote implies ${slip.percent.toFixed(2)}% slippage, above your ${slippageLimit.toFixed(2)}% limit.`);
  const net = calculateNetOpportunity({ grossSpreadPercent: o.spreadPercent, slippagePercent: slip.percent, gasUsd: quote.tradeFeeUsd, taxPercent: quote.taxRate !== null ? quote.taxRate * 100 : null, notional });
  if (!net || net.netPercent < rules.minNetEdgePercent) {
    return block("EXPECTED_OUTPUT", `With the fresh quote the estimated net edge is ${net ? net.netPercent.toFixed(2) : "unknown"}%, below your ${rules.minNetEdgePercent}% minimum.`);
  }
  steps.push({ step: "EXPECTED_OUTPUT", status: "ok", detail: `Expect ${preview.expectedOutput.amount} ${to.symbol}; estimated slippage ${slip.percent.toFixed(2)}%.` });

  // Floor at the user's slippage limit (BigInt, rounded down).
  const limitBps = BigInt(Math.round(slippageLimit * 100));
  const computedMin = (BigInt(quote.toAmountRaw) * (10_000n - limitBps)) / 10_000n;

  // ── 5. Transaction construction (Binance-built) ───────────────────────────
  const txs: SimulatedTx[] = [];
  let approveTx: SimulatedTx | null = null;
  if (route.approveTarget) {
    try {
      const { data } = await client.trading.approveTransaction({
        binanceChainId: BSC,
        tokenContractAddress: from.address,
        approveAmount: amountRaw.toString(), // exact amount, never unlimited
        vendor: route.vendorName ?? undefined,
      });
      const a = data?.[0];
      if (!a?.data) return block("BUILD", "The approval transaction couldn't be built.");
      const decoded = decodeApprove(a.data);
      const checks: SimulatedTx["checks"] = [];
      checks.push({ check: "APPROVE_CALLDATA", passed: !!decoded, detail: decoded ? "Standard ERC-20 approve()." : "Calldata is not a standard ERC-20 approve()." });
      if (decoded) {
        checks.push({
          check: "APPROVE_AMOUNT",
          passed: decoded.amount === amountRaw && decoded.amount !== MAX_UINT256,
          detail: decoded.amount === MAX_UINT256 ? "Unlimited approval requested; refused." : decoded.amount === amountRaw ? "Approves exactly this trade's amount." : "Approval amount differs from the trade amount.",
        });
        const spenderOk = sameAddress(decoded.spender, route.approveTarget) && (!a.dexContractAddress || sameAddress(decoded.spender, a.dexContractAddress));
        checks.push({ check: "APPROVE_SPENDER", passed: spenderOk, detail: spenderOk ? `Spender ${decoded.spender} matches the quote.` : `Spender ${decoded.spender} doesn't match the quote's approval target.` });
      }
      approveTx = { kind: "APPROVE", description: `Allow the ${route.vendorName ?? "router"} contract to spend exactly ${preview.input.amount} ${from.symbol}`, to: from.address, value: "0", data: a.data, gasLimit: a.gasLimit ?? null, simulation: null, checks };
      txs.push(approveTx);
    } catch (e) {
      return block("BUILD", `The approval transaction couldn't be built: ${errText(e)}`);
    }
  }

  let swapTx: SimulatedTx | null = null;
  try {
    const { data: built } = await client.trading.buildSwap({
      binanceChainId: BSC,
      amount: amountRaw.toString(),
      fromTokenAddress: from.address,
      toTokenAddress: to.address,
      userWalletAddress: wallet,
      quoteId: route.quoteId,
      slippagePercent: String(slippageLimit),
      approveTransaction: false,
    });
    const mode = built?.executionMode ?? route.executionMode ?? null;
    preview.route.executionMode = mode;

    if (mode === "SWAP") {
      const tx = built?.tx;
      if (!tx?.to || !tx.data) return block("BUILD", "The swap transaction is missing its target or data.");
      const checks: SimulatedTx["checks"] = [];
      checks.push({ check: "SENDER", passed: !tx.from || sameAddress(tx.from, wallet), detail: !tx.from || sameAddress(tx.from, wallet) ? "Sent from your wallet." : `Transaction sender ${tx.from} is not your wallet.` });
      checks.push({ check: "NATIVE_VALUE", passed: (tx.value ?? "0") === "0", detail: (tx.value ?? "0") === "0" ? "Sends no BNB." : `Would also send ${tx.value} wei of BNB.` });
      const minRecv = tx.minReceiveAmount && /^\d+$/.test(tx.minReceiveAmount) ? BigInt(tx.minReceiveAmount) : null;
      checks.push({
        check: "MIN_RECEIVE",
        passed: minRecv !== null && minRecv >= computedMin && minRecv <= BigInt(quote.toAmountRaw),
        detail: minRecv === null ? "No minimum output in the transaction." : minRecv >= computedMin ? "Minimum output respects your slippage limit." : "Minimum output is below your slippage limit.",
      });
      preview.minimumOutput = minRecv !== null ? { ...tokenAmt(to, minRecv.toString(), side === "BUY" ? tokenUsd : stablePrice), source: "TRANSACTION" } : null;
      swapTx = { kind: "SWAP", description: `Swap ${preview.input.amount} ${from.symbol} for at least ${preview.minimumOutput?.amount ?? "?"} ${to.symbol}`, to: tx.to, value: tx.value ?? "0", data: tx.data, gasLimit: tx.gas ?? null, simulation: null, checks };
      txs.push(swapTx);
    } else if (mode === "RFQ") {
      const review = inspectTypedData(built?.rfq?.typedDataToSign, { wallet, sellAmountRaw: amountRaw.toString(), minBuyAmountRaw: computedMin, now: now() });
      preview.rfqOrder = review;
      const buy = review.buyAmountRaw;
      preview.minimumOutput = buy
        ? { ...tokenAmt(to, buy, side === "BUY" ? tokenUsd : stablePrice), source: "TYPED_DATA" }
        : { ...tokenAmt(to, computedMin.toString(), side === "BUY" ? tokenUsd : stablePrice), source: "COMPUTED_FROM_SLIPPAGE" };
      warnings.push("RFQ orders are signed off-chain and settled by the vendor; the Transaction API can't simulate the order itself, so its contents were checked instead.");
    } else {
      return block("BUILD", `Unknown execution mode "${mode ?? "none"}".`);
    }
  } catch (e) {
    return block("BUILD", `The swap couldn't be built: ${errText(e)}`);
  }
  preview.transactions = txs;
  steps.push({ step: "BUILD", status: "ok", detail: `${txs.length ? txs.map((t) => t.kind.toLowerCase()).join(" + ") + " transaction" + (txs.length > 1 ? "s" : "") : "No on-chain transaction"}${preview.rfqOrder ? " + RFQ order" : ""} built by Binance.` });

  // ── 6. Gas ────────────────────────────────────────────────────────────────
  let gasPriceWei: bigint | null = null;
  try {
    const { data } = await client.transaction.gasPrice(BSC);
    const g = data?.evmLegacyGasPrice?.mediumGasPrice ?? data?.eip1559GasPrice?.mediumMaxFee;
    gasPriceWei = g && /^\d+$/.test(g) ? BigInt(g) : null;
  } catch (e) {
    warnings.push(`Gas price unavailable: ${errText(e)}`);
  }
  // USD per BNB implied by the quote's own figures (tradeFee USD ÷ estimateGasFee BNB). No external price.
  const quoteGasBnb = route.estimateGasFee && /^\d+$/.test(route.estimateGasFee) ? Number(route.estimateGasFee) / 1e18 : null;
  const bnbUsd = quote.tradeFeeUsd !== null && quoteGasBnb ? quote.tradeFeeUsd / quoteGasBnb : null;
  let totalBnb = 0;
  let complete = true;
  for (const t of txs) {
    if (t.gasLimit && /^\d+$/.test(t.gasLimit) && gasPriceWei !== null) totalBnb += Number(BigInt(t.gasLimit) * gasPriceWei) / 1e18;
    else complete = false;
  }
  if (!txs.length && quoteGasBnb !== null) totalBnb = 0; // RFQ: vendor pays settlement gas
  preview.gas = {
    totalBnb: complete ? totalBnb : null,
    totalUsd: complete && bnbUsd !== null ? totalBnb * bnbUsd : null,
    note: !txs.length
      ? "No on-chain transaction from your wallet; the RFQ vendor settles the trade."
      : complete
        ? bnbUsd !== null
          ? "Gas limit × current gas price, converted to USD with the quote's own fee figures."
          : "Gas limit × current gas price. USD value unavailable."
        : "Gas could not be fully estimated.",
  };

  // ── 7. Net result (estimates) ─────────────────────────────────────────────
  const gasUsd = preview.gas.totalUsd ?? 0;
  const inUsd = preview.input.usd;
  const outUsd = preview.expectedOutput.usd;
  if (inUsd !== null && outUsd !== null) preview.net.vsMarketUsd = outUsd - inUsd - gasUsd;
  // Value the token leg at the REFERENCE (per-token = per-share × ratio).
  const refTokenUsd = o.referencePrice * o.asset.tokenToShareRatio;
  const tokenLeg = side === "BUY" ? preview.expectedOutput.amount : preview.input.amount;
  const stableLegUsd = side === "BUY" ? inUsd : outUsd;
  if (stableLegUsd !== null) {
    const vsRef = side === "BUY" ? tokenLeg * refTokenUsd - stableLegUsd - gasUsd : stableLegUsd - tokenLeg * refTokenUsd - gasUsd;
    preview.net.vsReferenceUsd = vsRef;
    preview.net.vsReferencePercent = (vsRef / stableLegUsd) * 100;
  }

  // ── 8. Transaction API simulation ─────────────────────────────────────────
  const simulate = async (t: SimulatedTx) => {
    try {
      const { data } = await client.transaction.simulate({ binanceChainId: BSC, evmTx: { from: wallet, to: t.to, value: t.value, data: t.data } });
      t.simulation = { status: data?.status ?? "UNKNOWN", failReason: data?.failReason ?? null, passed: okStatus(data) };
      return data ?? null;
    } catch (e) {
      t.simulation = { status: "ERROR", failReason: errText(e), passed: false };
      return null;
    }
  };

  if (approveTx) {
    const sim = await simulate(approveTx);
    if (sim && approveTx.simulation?.passed) {
      const changes = sim.allowanceChanges ?? [];
      if (changes.length) {
        const hit = changes.find((c) => sameAddress(c.tokenAddress, from.address) && sameAddress(c.owner, wallet));
        const ok = !!hit && hit.postAmount === amountRaw.toString() && sameAddress(hit.spender, route.approveTarget);
        approveTx.checks.push({ check: "SIM_ALLOWANCE", passed: ok, detail: ok ? "Simulated allowance equals the trade amount for the quoted spender." : "Simulated allowance change doesn't match the approval." });
      } else {
        warnings.push("The simulator didn't report allowance changes for the approval.");
      }
    }
  }

  if (swapTx) {
    if (approveTx) {
      steps.push({ step: "SIMULATION", status: "skipped", detail: "The swap can only be simulated after the approval is on-chain." });
      return finish("APPROVAL_REQUIRED", "Approval needed first.", "This route needs an on-chain approval before the swap can be simulated. GapPilot won't ask you to confirm a swap it couldn't simulate.");
    }
    const sim = await simulate(swapTx);
    if (sim && swapTx.simulation?.passed) {
      const changes = (sim.balanceChanges ?? []).filter((c) => sameAddress(c.owner, wallet));
      if (changes.length) {
        const outflow = changes.find((c) => sameAddress(c.contractAddress, from.address));
        const inflow = changes.find((c) => sameAddress(c.contractAddress, to.address));
        const outOk = !!outflow?.change && /^-\d+$/.test(outflow.change) && BigInt(outflow.change) === -amountRaw;
        const minRecv = preview.minimumOutput ? BigInt(preview.minimumOutput.raw) : computedMin;
        const inOk = !!inflow?.change && /^\d+$/.test(inflow.change) && BigInt(inflow.change) >= minRecv;
        swapTx.checks.push({ check: "SIM_SPEND", passed: outOk, detail: outOk ? `Simulation spends exactly ${preview.input.amount} ${from.symbol}.` : "Simulated spend doesn't match the quote." });
        swapTx.checks.push({ check: "SIM_RECEIVE", passed: inOk, detail: inOk ? `Simulation receives at least the minimum ${to.symbol}.` : "Simulated output is below the minimum." });
      } else {
        warnings.push("The simulator didn't report balance changes for the swap.");
      }
    }
  }

  // ── 9. Verdict ────────────────────────────────────────────────────────────
  const failedSim = txs.find((t) => t.simulation && !t.simulation.passed);
  if (failedSim) {
    steps.push({ step: "SIMULATION", status: "failed", detail: `${failedSim.kind} simulation failed.` });
    return finish("FAILED", "Simulation failed. Nothing will be executed.", failedSim.simulation!.failReason ?? `Simulator status: ${failedSim.simulation!.status}`);
  }
  const failedCheck = [...txs.flatMap((t) => t.checks), ...(preview.rfqOrder?.checks ?? [])].find((c) => !c.passed);
  if (failedCheck) {
    steps.push({ step: "SIMULATION", status: "failed", detail: failedCheck.detail });
    const unreadable = preview.rfqOrder && !preview.rfqOrder.decodable;
    return finish(unreadable ? "UNVERIFIABLE" : "FAILED", unreadable ? "This order can't be verified." : "A safety check failed. Nothing will be executed.", failedCheck.detail);
  }
  if (!txs.some((t) => t.simulation?.passed)) {
    steps.push({ step: "SIMULATION", status: "skipped", detail: "No transaction to simulate." });
    return finish(
      "UNVERIFIABLE",
      "Nothing here can be simulated.",
      "This RFQ trade needs no on-chain transaction from your wallet (the allowance already exists), and the Transaction API can't simulate an off-chain order. GapPilot won't ask you to approve a trade it couldn't simulate.",
    );
  }
  steps.push({ step: "SIMULATION", status: "ok", detail: `${txs.filter((t) => t.simulation?.passed).map((t) => t.kind.toLowerCase()).join(" and ")} simulation passed.` });
  return finish("PASSED", "Simulation passed.");
}
