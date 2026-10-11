/**
 * Execution orchestration. One path for every execution, user-approved or
 * autonomous:
 *
 *   request (from a PASSED preview) → provider preflight → authorizeExecution
 *   → provider.execute (only if authorized) → audit record (always)
 */
import type { BinanceWeb3Client } from "../binance/facade";
import { runAgentDeterministic } from "../agent/deterministic";
import type { UserRules } from "../agent/types";
import { OpportunityScanner } from "../engine/scanner";
import type { Opportunity } from "../engine/types";
import { matchStrategy } from "../strategy/match";
import type { Strategy } from "../strategy/schema";
import { buildTradePreview } from "../trade/planner";
import type { TradePreview } from "../trade/types";
import { auditContent, usageFrom, type AuditLog } from "./audit";
import { authorizeExecution, buildExecutionRequest } from "./policy";
import type { Authorization, AuditRecord, AutonomyGrant, ExecutionProvider, ExecutionResult } from "./types";

export async function executeWithAuthorization(args: {
  provider: ExecutionProvider;
  preview: TradePreview;
  opportunity: Opportunity;
  rules: UserRules;
  strategy: Strategy | null;
  strategyName: string | null;
  authorization: Authorization | null;
  quoteTokenAddress: string;
  audit: AuditLog;
  now: () => number;
}): Promise<AuditRecord> {
  const { provider, preview, opportunity } = args;
  const request = buildExecutionRequest(preview, opportunity);
  const preflight = await provider.preflight(request ?? undefined);
  const grantId = args.authorization?.type === "AUTONOMOUS_GRANT" ? args.authorization.grant.grantId : null;
  const usage = usageFrom(args.audit.list(), { now: args.now(), grantId, mode: provider.mode });
  const verdict = authorizeExecution({
    request,
    preview,
    opportunity,
    rules: args.rules,
    strategy: args.strategy,
    authorization: args.authorization,
    quoteTokenAddress: args.quoteTokenAddress,
    preflight,
    usage,
    now: args.now(),
  });
  const agentDecision = runAgentDeterministic(opportunity, args.rules).decision;

  let result: ExecutionResult | null = null;
  if (verdict.authorized && request) {
    try {
      result = await provider.execute(request, verdict.proof);
    } catch (e) {
      result = { mode: provider.mode, provider: provider.id, status: "FAILED", orderId: null, txHash: null, actualOutputRaw: null, detail: e instanceof Error ? e.message : String(e) };
    }
  }
  return args.audit.append(
    auditContent({
      now: args.now(),
      mode: provider.mode,
      provider: provider.id,
      opportunity,
      strategy: args.strategy,
      strategyName: args.strategyName,
      agentDecision,
      preview,
      authorization: args.authorization,
      violations: verdict.authorized ? [] : verdict.violations,
      result,
    }),
  );
}

export interface CycleResult {
  wallet: string | null;
  scanned: number;
  candidates: Array<{ symbol: string; spreadPercent: number }>;
  records: AuditRecord[];
  note: string;
}

/**
 * One autonomous cycle: at most ONE execution attempt (the best candidate).
 * Never raises limits: notional = min(grant, strategy, rules).
 */
export async function runAutonomousCycle(args: {
  client: BinanceWeb3Client;
  provider: ExecutionProvider;
  grant: AutonomyGrant;
  strategy: Strategy;
  strategyName: string;
  rules: UserRules;
  quoteTokenAddress: string;
  audit: AuditLog;
  now?: () => number;
  maxPairs?: number;
}): Promise<CycleResult> {
  const now = args.now ?? Date.now;
  const pre = await args.provider.preflight();
  if (!pre.ready || !pre.wallet) {
    return { wallet: pre.wallet, scanned: 0, candidates: [], records: [], note: `Provider not ready: ${pre.detail}` };
  }
  if (now() > args.grant.expiresAt) return { wallet: pre.wallet, scanned: 0, candidates: [], records: [], note: "The autonomous grant has expired." };

  const notional = Math.min(args.grant.maxTradeUsd, args.strategy.maximumTradeUsd, args.rules.maxNotionalUsd);
  const scan = await new OpportunityScanner(args.client, now).scan({
    notional,
    wallet: pre.wallet,
    quoteTokenAddress: args.quoteTokenAddress,
    maxPairs: args.maxPairs ?? 10,
  });
  const candidates = scan.opportunities.filter(
    (o) => matchStrategy(args.strategy, o).matches && runAgentDeterministic(o, args.rules).decision === "EXECUTABLE",
  );
  const summary = candidates.map((c) => ({ symbol: c.asset.symbol, spreadPercent: c.spreadPercent }));
  if (!candidates.length) {
    return { wallet: pre.wallet, scanned: scan.opportunities.length, candidates: [], records: [], note: "No opportunity matches the strategy and passes the agent right now." };
  }

  const best = candidates[0]!;
  const preview = await buildTradePreview({
    client: args.client,
    opportunity: best,
    wallet: pre.wallet,
    rules: args.rules,
    strategy: args.strategy,
    quoteTokenAddress: args.quoteTokenAddress,
    now,
  });
  const record = await executeWithAuthorization({
    provider: args.provider,
    preview,
    opportunity: best,
    rules: args.rules,
    strategy: args.strategy,
    strategyName: args.strategyName,
    authorization: { type: "AUTONOMOUS_GRANT", grant: args.grant },
    quoteTokenAddress: args.quoteTokenAddress,
    audit: args.audit,
    now,
  });
  return {
    wallet: pre.wallet,
    scanned: scan.opportunities.length,
    candidates: summary,
    records: [record],
    note: record.result === "REFUSED" ? "The best candidate was refused by the execution policy." : `Executed (${record.mode.toLowerCase()}).`,
  };
}
