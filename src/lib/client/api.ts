import type { Opportunity } from "../engine/types";
import type { DashboardScan } from "../server/opportunities";
import type { AgentOutput, UserRules } from "../agent/types";
import type { CompileResult, Strategy } from "../strategy/schema";
import type { TradePreview } from "../trade/types";
import type { AuditRecord, AutonomyGrant } from "../execution/types";

export type { DashboardScan };

export class ApiError extends Error {
  constructor(
    readonly kind: string,
    message: string,
    readonly httpStatus: number,
    readonly upstreamStatus?: number,
  ) {
    super(message);
  }
}

export async function fetchScan(
  q: { notional: number; maxPairs: number; wallet?: string },
  signal?: AbortSignal,
): Promise<DashboardScan> {
  const params = new URLSearchParams({ notional: String(q.notional), maxPairs: String(q.maxPairs) });
  if (q.wallet) params.set("wallet", q.wallet);
  let res: Response;
  try {
    res = await fetch(`/api/opportunities?${params}`, { signal, cache: "no-store" });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("offline", "Could not reach the GapPilot server.", 0);
  }
  const body = (await res.json().catch(() => null)) as
    | { ok: true; data: DashboardScan }
    | { ok: false; error: { kind: string; message: string; upstreamStatus?: number } }
    | null;
  if (!body) throw new ApiError("parse", "The server returned an unreadable response.", res.status);
  if (!body.ok) throw new ApiError(body.error.kind, body.error.message, res.status, body.error.upstreamStatus);
  return body.data;
}

export type AgentResponse =
  | { ok: true; data: AgentOutput }
  | { ok: false; error: { kind: string; message: string } };

/** Server-side agent run. With narrate=true the server asks the LLM for a verified summary. */
export async function fetchAgent(o: Opportunity, attestation: string, rules: UserRules, narrate: boolean): Promise<AgentResponse> {
  try {
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ opportunity: JSON.stringify(o), attestation, rules, narrate }),
    });
    const body = (await res.json().catch(() => null)) as AgentResponse | null;
    return body ?? { ok: false, error: { kind: "parse", message: "Unreadable response." } };
  } catch {
    return { ok: false, error: { kind: "offline", message: "Could not reach the GapPilot server." } };
  }
}

export type ParseResponse = CompileResult & { parserNote?: string };

export async function parseStrategy(text: string): Promise<ParseResponse | { error: string }> {
  try {
    const res = await fetch("/api/strategy/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    const body = (await res.json().catch(() => null)) as (ParseResponse & { error?: { message: string } }) | null;
    if (!body) return { error: "Unreadable response." };
    if (!res.ok && body.error) return { error: body.error.message };
    return body;
  } catch {
    return { error: "Could not reach the GapPilot server." };
  }
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { kind: string; message: string } };

async function postJson<T>(url: string, body: unknown): Promise<Envelope<T>> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const parsed = (await res.json().catch(() => null)) as Envelope<T> | null;
    return parsed ?? { ok: false, error: { kind: "parse", message: "Unreadable response." } };
  } catch {
    return { ok: false, error: { kind: "offline", message: "Could not reach the GapPilot server." } };
  }
}

/** Quote → Binance-built transactions → Transaction API simulation. Never signs or sends. */
export function simulateTrade(args: { opportunity: Opportunity; attestation: string; wallet: string; rules: UserRules; strategy: Strategy | null; strategyName?: string | null }) {
  return postJson<TradePreview>("/api/trade/simulate", {
    opportunity: JSON.stringify(args.opportunity),
    attestation: args.attestation,
    wallet: args.wallet,
    rules: args.rules,
    strategy: args.strategy,
    strategyName: args.strategyName ?? null,
  });
}

/** Explicit approval of a PASSED simulation, executed by the configured provider (SIMULATED in the web app). */
export function approveTrade(args: { planToken: string; wallet: string; preview: TradePreview; opportunity: Opportunity; attestation: string }) {
  return postJson<AuditRecord>("/api/trade/approve", {
    planToken: args.planToken,
    wallet: args.wallet,
    confirm: true,
    preview: args.preview,
    opportunity: JSON.stringify(args.opportunity),
    attestation: args.attestation,
  });
}

export function createAutonomyGrant(args: { strategy: Strategy; strategyName: string; maxTradeUsd: number; maxTradesPerDay: number; maxDailyUsd: number; durationHours: number }) {
  return postJson<{ grant: AutonomyGrant; grantToken: string }>("/api/autonomy/grant", { ...args, consent: true });
}

export function runAutonomyCycle(args: { grantToken: string; strategy: Strategy; rules: UserRules; wallet: string }) {
  return postJson<{ wallet: string | null; scanned: number; candidates: Array<{ symbol: string; spreadPercent: number }>; records: AuditRecord[]; note: string; mode: "SIMULATED" }>("/api/autonomy/run", args);
}
