/**
 * Append-only, hash-chained audit log. Every execution attempt — refused,
 * failed, simulated or live — produces exactly one record. Each record's hash
 * covers its content and the previous hash, so edits or deletions are detectable.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Opportunity } from "../engine/types";
import type { Strategy } from "../strategy/schema";
import type { TradePreview } from "../trade/types";
import { canonicalJson, strategyHash } from "./policy";
import type { Authorization, AuditRecord, ExecutionMode, ExecutionResult, ProviderId, Violation } from "./types";

export function hashRecord(content: Omit<AuditRecord, "hash">): string {
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

export function verifyChain(records: AuditRecord[]): { valid: boolean; brokenAt: number | null } {
  let prev: string | null = null;
  for (let i = 0; i < records.length; i++) {
    const { hash, ...content } = records[i]!;
    if (content.prevHash !== prev || hashRecord(content) !== hash) return { valid: false, brokenAt: i };
    prev = hash;
  }
  return { valid: true, brokenAt: null };
}

export interface AuditLog {
  append(content: Omit<AuditRecord, "hash" | "prevHash">): AuditRecord;
  list(): AuditRecord[];
}

export class InMemoryAuditLog implements AuditLog {
  protected records: AuditRecord[] = [];
  append(content: Omit<AuditRecord, "hash" | "prevHash">): AuditRecord {
    const withPrev = { ...content, prevHash: this.records.at(-1)?.hash ?? null };
    const record: AuditRecord = { ...withPrev, hash: hashRecord(withPrev) };
    this.records.push(record);
    return record;
  }
  list(): AuditRecord[] {
    return [...this.records];
  }
}

/** JSON Lines on disk, for the local agent worker. Loads and verifies the chain on open. */
export class JsonlFileAuditLog extends InMemoryAuditLog {
  constructor(private readonly file: string) {
    super();
    if (existsSync(file)) {
      const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
      this.records = lines.map((l) => JSON.parse(l) as AuditRecord);
      const check = verifyChain(this.records);
      if (!check.valid) throw new Error(`Audit log ${file} failed verification at record ${check.brokenAt}. Refusing to continue.`);
    } else {
      mkdirSync(path.dirname(file), { recursive: true });
    }
  }
  override append(content: Omit<AuditRecord, "hash" | "prevHash">): AuditRecord {
    const r = super.append(content);
    appendFileSync(this.file, `${JSON.stringify(r)}\n`);
    return r;
  }
}

/** Usage today (UTC) for limit checks: counts only real or simulated fills/pending, not refusals. */
export function usageFrom(records: AuditRecord[], opts: { now: number; grantId?: string | null; mode?: ExecutionMode }) {
  const dayStart = Date.UTC(new Date(opts.now).getUTCFullYear(), new Date(opts.now).getUTCMonth(), new Date(opts.now).getUTCDate());
  const executed = records.filter((r) => ["FILLED", "SIMULATED_FILL", "FILLED_BELOW_MINIMUM", "PENDING"].includes(r.result));
  const today = executed.filter((r) => r.timestamp >= dayStart && (!opts.grantId || r.authorization.grantId === opts.grantId) && (!opts.mode || r.mode === opts.mode));
  return {
    tradesToday: today.length,
    usdToday: today.reduce((s, r) => s + (r.quote?.inputUsd ?? 0), 0),
    executedQuoteIds: new Set(executed.map((r) => r.quote?.quoteId).filter((q): q is string => !!q)),
  };
}

/** Builds the record content from the pipeline's pieces. */
export function auditContent(args: {
  now: number;
  mode: ExecutionMode;
  provider: ProviderId;
  opportunity: Opportunity | null;
  strategy: Strategy | null;
  strategyName: string | null;
  agentDecision: string | null;
  preview: TradePreview | null;
  authorization: Authorization | null;
  violations: Violation[];
  result: ExecutionResult | null;
}): Omit<AuditRecord, "hash" | "prevHash"> {
  const { opportunity: o, preview: p, result: x } = args;
  const fmt = (t: { amount: number; symbol: string; usd: number | null } | null) =>
    t ? `${Number(t.amount.toPrecision(8)).toString()} ${t.symbol}${t.usd !== null ? ` ($${t.usd.toFixed(2)})` : ""}` : null;
  const verdict = args.violations.length || !args.authorization ? "REFUSED" : "AUTHORIZED";
  const result: AuditRecord["result"] =
    verdict === "REFUSED" ? "REFUSED"
      : !x ? "FAILED"
      : x.status === "FILLED" ? (x.mode === "SIMULATED" ? "SIMULATED_FILL" : "FILLED")
      : x.status === "FILLED_BELOW_MINIMUM" ? "FILLED_BELOW_MINIMUM"
      : x.status === "PENDING" ? "PENDING"
      : "FAILED";
  return {
    id: randomUUID(),
    timestamp: args.now,
    mode: args.mode,
    provider: args.provider,
    asset: o ? { symbol: o.asset.symbol, address: o.asset.address, issuer: o.asset.issuer, underlyingTicker: o.asset.underlyingTicker } : null,
    strategy: args.strategy ? { name: args.strategyName ?? "Strategy", hash: strategyHash(args.strategy) } : null,
    signal: o
      ? { direction: o.direction, spreadPercent: o.spreadPercent, referenceKind: o.referenceKind, referenceSource: o.referenceSource, engineAction: o.action, agentDecision: args.agentDecision ?? "UNKNOWN" }
      : null,
    quote: p
      ? {
          quoteId: p.quoteId,
          vendor: p.route.vendor,
          executionMode: p.route.executionMode,
          input: fmt(p.input),
          inputUsd: p.input?.usd ?? null,
          expectedOutput: fmt(p.expectedOutput),
          minimumOutput: fmt(p.minimumOutput),
          slippageLimitPercent: p.slippageLimitPercent,
        }
      : null,
    simulation: p ? { status: p.status, transactions: p.transactions.map((t) => ({ kind: t.kind, status: t.simulation?.status ?? "NOT_SIMULATED" })), failureReason: p.failureReason } : null,
    authorization: {
      state: args.authorization?.type ?? "NONE",
      approvalId: args.authorization?.type === "USER_APPROVED" ? args.authorization.approvalId : null,
      grantId: args.authorization?.type === "AUTONOMOUS_GRANT" ? args.authorization.grant.grantId : null,
      verdict,
      violations: args.violations,
    },
    execution: x
      ? { status: x.status, orderId: x.orderId, txHash: x.txHash, actualOutputRaw: x.actualOutputRaw, detail: x.detail }
      : { status: "NOT_ATTEMPTED", orderId: null, txHash: null, actualOutputRaw: null, detail: verdict === "REFUSED" ? "Refused before execution." : "No result." },
    result,
  };
}
