/**
 * authorizeExecution — the single, deterministic gate in front of every
 * provider. It enforces the hard constraints; nothing (agent, LLM, grant,
 * provider) can relax them:
 *
 *   - no execution without a PASSED Transaction API simulation that is still valid
 *   - trade size ≤ min(user rules, strategy, grant)  (the agent can't raise it)
 *   - slippage ≤ min(user rules, strategy); executed at exactly that limit
 *   - spot swap of a supported tokenized stock against the configured stablecoin only
 *   - no leverage/perps (the request type can't express them; checked anyway)
 *   - wallet safety: balance verified, approvals exact, same wallet, provider ready
 *   - autonomous runs: agent EXECUTABLE, strategy matches, grant valid and within
 *     its daily caps, no duplicate execution of the same quote
 */
import { createHash, randomUUID } from "node:crypto";
import { runAgentDeterministic } from "../agent/deterministic";
import type { UserRules } from "../agent/types";
import type { Opportunity } from "../engine/types";
import { matchStrategy } from "../strategy/match";
import type { Strategy } from "../strategy/schema";
import { MAX_UINT256, decodeApprove, sameAddress } from "../trade/calldata";
import type { TradePreview } from "../trade/types";
import {
  AutonomyGrantSchema,
  type Authorization,
  type AuthorizationProof,
  type AutonomyGrant,
  type ExecutionRequest,
  type ProviderPreflight,
  type Violation,
} from "./types";

export const SUPPORTED_ISSUERS = new Set(["bstock", "ondo"]);

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
    .join(",")}}`;
}

/** Canonical strategy hash: grants are bound to one exact strategy. */
export function strategyHash(s: Strategy): string {
  return createHash("sha256").update(canonicalJson(s)).digest("hex");
}

export function previewDigest(p: TradePreview): string {
  const { planToken: _t, ...rest } = p;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

/** Creates a grant that can never exceed the strategy's own limits. */
export function createGrant(args: {
  strategy: Strategy;
  strategyName: string;
  maxTradeUsd: number;
  maxTradesPerDay: number;
  maxDailyUsd: number;
  durationMs: number;
  provider: AutonomyGrant["provider"];
  now: number;
}): { ok: true; grant: AutonomyGrant } | { ok: false; message: string } {
  if (args.maxTradeUsd > args.strategy.maximumTradeUsd) {
    return { ok: false, message: `Per-trade limit can't exceed the strategy's $${args.strategy.maximumTradeUsd}.` };
  }
  const parsed = AutonomyGrantSchema.safeParse({
    v: 1,
    grantId: randomUUID(),
    strategyHash: strategyHash(args.strategy),
    strategyName: args.strategyName,
    maxTradeUsd: args.maxTradeUsd,
    maxTradesPerDay: args.maxTradesPerDay,
    maxDailyUsd: args.maxDailyUsd,
    provider: args.provider,
    createdAt: args.now,
    expiresAt: args.now + args.durationMs,
  });
  return parsed.success ? { ok: true, grant: parsed.data } : { ok: false, message: parsed.error.issues.map((i) => i.message).join("; ") };
}

/** Builds the provider request from a PASSED preview (server-side, trusted data only). */
export function buildExecutionRequest(p: TradePreview, o: Opportunity): ExecutionRequest | null {
  if (p.status !== "PASSED" || !p.input || !p.expectedOutput || !p.minimumOutput) return null;
  return {
    requestId: randomUUID(),
    kind: "SPOT_SWAP",
    chainId: "56",
    side: p.side,
    wallet: p.wallet,
    asset: { address: o.asset.address, symbol: o.asset.symbol, issuer: o.asset.issuer, underlyingTicker: o.asset.underlyingTicker },
    input: { address: p.input.address, symbol: p.input.symbol, decimals: p.input.decimals, raw: p.input.raw, usd: p.input.usd },
    output: { address: p.expectedOutput.address, symbol: p.expectedOutput.symbol, decimals: p.expectedOutput.decimals, expectedRaw: p.expectedOutput.raw, minimumRaw: p.minimumOutput.raw },
    slippageLimitPercent: p.slippageLimitPercent,
    quoteId: p.quoteId,
    previewHash: previewDigest(p),
    expiresAt: p.expiresAt,
  };
}

export interface AuthorizationContext {
  request: ExecutionRequest | null;
  preview: TradePreview;
  opportunity: Opportunity;
  rules: UserRules;
  strategy: Strategy | null;
  authorization: Authorization | null;
  /** Stablecoin GapPilot is configured to trade against. */
  quoteTokenAddress: string;
  preflight: ProviderPreflight;
  /** From the audit log: executions today under this grant/wallet, and quotes already executed. */
  usage: { tradesToday: number; usdToday: number; executedQuoteIds: ReadonlySet<string> };
  now: number;
}

export type AuthorizationVerdict =
  | { authorized: true; proof: AuthorizationProof; limits: { maxTradeUsd: number; slippageLimitPercent: number } }
  | { authorized: false; violations: Violation[]; limits: { maxTradeUsd: number; slippageLimitPercent: number } };

const EPS = 1e-9;

export function authorizeExecution(ctx: AuthorizationContext): AuthorizationVerdict {
  const v: Violation[] = [];
  const add = (code: Violation["code"], message: string) => v.push({ code, message });
  const { request: r, preview: p, opportunity: o, rules, strategy, authorization: auth } = ctx;
  const grant = auth?.type === "AUTONOMOUS_GRANT" ? auth.grant : null;

  // Effective limits: the minimum of every source. Nothing can raise them.
  const maxTradeUsd = Math.min(rules.maxNotionalUsd, strategy?.maximumTradeUsd ?? Infinity, grant?.maxTradeUsd ?? Infinity);
  const slippageLimitPercent = Math.min(rules.maxSlippagePercent, strategy?.maximumSlippagePercent ?? Infinity);
  const limits = { maxTradeUsd, slippageLimitPercent };

  // Authorization present
  if (!auth) add("NO_AUTHORIZATION", "No user approval and no autonomous grant.");

  // Simulation
  if (p.status !== "PASSED" || !r) add("SIMULATION_NOT_PASSED", `Simulation status is ${p.status}; execution requires a passed simulation.`);
  else if (!p.transactions.some((t) => t.simulation?.passed)) add("SIMULATION_NOT_PASSED", "No transaction was simulated.");
  if (ctx.now > p.expiresAt || (r && ctx.now > r.expiresAt)) add("PLAN_EXPIRED", "The quote and simulation have expired; simulate again.");
  if (r && r.previewHash !== previewDigest(p)) add("SIMULATION_NOT_PASSED", "The execution request doesn't match the simulated preview.");

  // Spot only, supported assets only
  if (r && r.kind !== "SPOT_SWAP") add("LEVERAGE_OR_DERIVATIVES", "Only spot swaps are allowed.");
  if (r && r.chainId !== "56") add("UNSUPPORTED_ASSET", "Only BNB Smart Chain is supported.");
  if (!SUPPORTED_ISSUERS.has(o.asset.issuer)) add("UNSUPPORTED_ASSET", `Issuer ${o.asset.issuer} isn't supported.`);
  if (r) {
    const legs = [r.input.address, r.output.address];
    const pairOk =
      legs.some((a) => sameAddress(a, o.asset.address)) &&
      legs.some((a) => sameAddress(a, ctx.quoteTokenAddress)) &&
      !sameAddress(r.input.address, r.output.address);
    if (!pairOk) add("UNSUPPORTED_ASSET", "A trade must swap the scanned tokenized stock against the configured stablecoin.");
    if (!sameAddress(r.asset.address, o.asset.address)) add("UNSUPPORTED_ASSET", "The request's asset doesn't match the opportunity.");
  }
  if (strategy) {
    const scope = strategy.assetScope;
    if (scope.type === "TICKERS" && !scope.tickers.includes(o.asset.underlyingTicker.toUpperCase())) add("UNSUPPORTED_ASSET", "The asset is outside the strategy's tickers.");
    if (scope.type === "ISSUERS" && !(scope.issuers as string[]).includes(o.asset.issuer)) add("UNSUPPORTED_ASSET", "The issuer is outside the strategy's scope.");
  }

  // Size and slippage
  const tradeUsd = r?.input.usd ?? null;
  if (tradeUsd === null) add("TRADE_SIZE_EXCEEDS_LIMIT", "Trade size in USD is unknown, so the limit can't be confirmed.");
  else if (tradeUsd > maxTradeUsd + EPS) add("TRADE_SIZE_EXCEEDS_LIMIT", `Trade size $${tradeUsd.toFixed(2)} exceeds the $${maxTradeUsd.toFixed(2)} limit.`);
  if (r && r.slippageLimitPercent > slippageLimitPercent + EPS) add("SLIPPAGE_EXCEEDS_LIMIT", `Requested slippage ${r.slippageLimitPercent}% exceeds the ${slippageLimitPercent}% limit.`);
  if (p.estimatedSlippagePercent === null || p.estimatedSlippagePercent > slippageLimitPercent + EPS) {
    add("SLIPPAGE_EXCEEDS_LIMIT", `Estimated slippage ${p.estimatedSlippagePercent?.toFixed(2) ?? "unknown"}% exceeds the ${slippageLimitPercent}% limit.`);
  }
  if (r && BigInt(r.output.minimumRaw) <= 0n) add("SLIPPAGE_EXCEEDS_LIMIT", "No minimum output is enforced.");

  // Wallet safety
  if (r && !sameAddress(r.wallet, p.wallet)) add("WALLET_MISMATCH", "The request's wallet differs from the simulated wallet.");
  if (ctx.preflight.wallet && !sameAddress(ctx.preflight.wallet, p.wallet)) add("WALLET_MISMATCH", "The executing wallet differs from the simulated wallet.");
  if (!p.steps.some((s) => s.step === "BALANCE" && s.status === "ok")) add("WALLET_SAFETY", "The wallet balance wasn't verified.");
  for (const t of p.transactions.filter((t) => t.kind === "APPROVE")) {
    const d = decodeApprove(t.data);
    if (!d || d.amount === MAX_UINT256 || (r && d.amount !== BigInt(r.input.raw))) add("WALLET_SAFETY", "Approval isn't an exact-amount approve().");
  }
  if ([...p.transactions.flatMap((t) => t.checks), ...(p.rfqOrder?.checks ?? [])].some((c) => !c.passed)) add("WALLET_SAFETY", "A transaction safety check failed.");
  if (!ctx.preflight.ready) add("PROVIDER_NOT_READY", ctx.preflight.detail);
  if (ctx.preflight.quotaLeftUsd !== null && tradeUsd !== null && tradeUsd > ctx.preflight.quotaLeftUsd + EPS) {
    add("PROVIDER_QUOTA", `The wallet's remaining daily quota ($${ctx.preflight.quotaLeftUsd.toFixed(2)}) is below the trade size.`);
  }

  // Duplicate protection
  if (p.quoteId && ctx.usage.executedQuoteIds.has(p.quoteId)) add("DUPLICATE", "This quote was already executed.");

  // Autonomous-only gates
  if (grant) {
    const g = AutonomyGrantSchema.safeParse(grant);
    if (!g.success) add("GRANT_INVALID", "The autonomous grant is malformed.");
    if (ctx.now > grant.expiresAt) add("GRANT_EXPIRED", "The autonomous grant has expired.");
    if (!strategy) add("GRANT_INVALID", "Autonomous execution requires the granted strategy.");
    else if (strategyHash(strategy) !== grant.strategyHash) add("GRANT_INVALID", "The strategy differs from the one the grant covers.");
    if (strategy && grant.maxTradeUsd > strategy.maximumTradeUsd + EPS) add("GRANT_INVALID", "The grant's per-trade limit exceeds the strategy's.");
    if (ctx.usage.tradesToday >= grant.maxTradesPerDay) add("DAILY_LIMIT", `Daily trade count reached (${grant.maxTradesPerDay}).`);
    if (tradeUsd !== null && ctx.usage.usdToday + tradeUsd > grant.maxDailyUsd + EPS) add("DAILY_LIMIT", `This trade would exceed the $${grant.maxDailyUsd} daily cap.`);
    const agent = runAgentDeterministic(o, rules);
    if (agent.decision !== "EXECUTABLE") add("AGENT_NOT_EXECUTABLE", `The agent decided ${agent.decision} / ${agent.recommendedAction}.`);
    if (strategy && !matchStrategy(strategy, o).matches) add("STRATEGY_MISMATCH", "The opportunity no longer matches the strategy.");
  }

  if (v.length || !auth || !r) return { authorized: false, violations: v, limits };
  return {
    authorized: true,
    limits,
    proof: { authorization: auth, requestId: r.requestId, previewHash: r.previewHash, authorizedAt: ctx.now, verdict: "AUTHORIZED" },
  };
}

/** Providers call this before acting: defense in depth against a bypassed policy. */
export function assertProof(request: ExecutionRequest, proof: AuthorizationProof | null | undefined, now: number): void {
  if (!proof || proof.verdict !== "AUTHORIZED") throw new Error("Execution refused: no authorization verdict.");
  if (proof.requestId !== request.requestId || proof.previewHash !== request.previewHash) throw new Error("Execution refused: authorization is for a different request.");
  if (now > request.expiresAt) throw new Error("Execution refused: the request has expired.");
  if (request.kind !== "SPOT_SWAP") throw new Error("Execution refused: only spot swaps.");
  if (!(request.slippageLimitPercent > 0)) throw new Error("Execution refused: a slippage limit is required.");
  if (BigInt(request.output.minimumRaw) <= 0n) throw new Error("Execution refused: a minimum output is required.");
}
