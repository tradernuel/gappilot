/**
 * DEMO ONLY. In-browser handlers for /api/* that call the SAME library functions
 * as the Next.js routes, against the simulated Binance backend. Secrets here are
 * demo-only constants; the real app keeps its secrets on the server.
 */
import { BinanceWeb3Client } from "../lib/binance/facade";
import { attest, verifyAttestation } from "../lib/assessment/attestation";
import { OpportunityScanner } from "../lib/engine/scanner";
import type { Opportunity } from "../lib/engine/types";
import { runAgentDeterministic } from "../lib/agent/deterministic";
import { DEFAULT_USER_RULES, UserRulesSchema, type UserRules } from "../lib/agent/types";
import { compileStrategy } from "../lib/strategy/compile";
import { parseWithRules } from "../lib/strategy/rules-parser";
import { StrategySchema, type Strategy } from "../lib/strategy/schema";
import { buildTradePreview } from "../lib/trade/planner";
import { approvePlan, attachPlanToken, signGrant, verifyGrantToken } from "../lib/trade/approval";
import type { TradePreview } from "../lib/trade/types";
import { InMemoryAuditLog } from "../lib/execution/audit";
import { MockExecutionProvider } from "../lib/execution/mock-provider";
import { createGrant } from "../lib/execution/policy";
import { executeWithAuthorization, runAutonomousCycle } from "../lib/execution/runner";
import { AutonomyGrantSchema, type AuditRecord } from "../lib/execution/types";
import { applyDemoFill, DEMO_USDT, demoBinanceFetch } from "./backend";

const DEMO_SECRET = "gappilot-demo-secret-not-a-real-key";
const client = BinanceWeb3Client.create({
  apiKey: "demo-key",
  apiSecret: DEMO_SECRET,
  baseUrl: "https://web3.binance.com/build",
  recvWindowMs: 5_000,
  timeoutMs: 10_000,
  fetchImpl: demoBinanceFetch,
  maxRetries: 0,
});
const audit = new InMemoryAuditLog();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (kind: string, message: string, status = 400) => json({ ok: false, error: { kind, message } }, status);
const rulesOf = (r: unknown): UserRules => (UserRulesSchema.safeParse(r).success ? (r as UserRules) : DEFAULT_USER_RULES);
const strategyOf = (s: unknown): Strategy | null => (s && StrategySchema.safeParse(s).success ? (s as Strategy) : null);

function verifiedOpportunity(body: { opportunity?: string; attestation?: string }): Opportunity | null {
  if (!body.opportunity || !body.attestation || !verifyAttestation(body.opportunity, body.attestation, DEMO_SECRET)) return null;
  return JSON.parse(body.opportunity) as Opportunity;
}

/** Moves demo balances after a simulated fill so later scans reflect it. */
function settle(record: AuditRecord, side: "BUY" | "SELL" | null) {
  if (record.result !== "SIMULATED_FILL" || !record.asset || !side || !record.quote) return;
  const units = (s: string | null) => Number((s ?? "0").split(" ")[0]);
  applyDemoFill(side, record.asset.symbol, units(record.quote.input), units(record.quote.expectedOutput));
}

export async function handleApi(path: string, method: string, url: URL, body: Record<string, unknown>): Promise<Response> {
  switch (`${method} ${path}`) {
    case "GET /api/opportunities": {
      const result = await new OpportunityScanner(client).scan({
        notional: Number(url.searchParams.get("notional") ?? 100),
        wallet: url.searchParams.get("wallet") ?? undefined,
        maxPairs: Number(url.searchParams.get("maxPairs") ?? 10),
        quoteTokenAddress: DEMO_USDT,
      });
      const attestations = Object.fromEntries(result.opportunities.map((o) => [o.asset.address, attest(JSON.stringify(o), DEMO_SECRET)]));
      return json({ ok: true, data: { ...result, attestations, cachedAt: Date.now() } });
    }

    case "POST /api/agent": {
      const o = verifiedOpportunity(body as never);
      if (!o) return fail("invalid", "This opportunity was not produced by this server, or it was modified.");
      const out = runAgentDeterministic(o, rulesOf(body.rules));
      return json({ ok: true, data: { ...out, guardrails: { clamped: [], llm: body.narrate ? "not_configured" : "not_requested" } } });
    }

    case "POST /api/strategy/parse": {
      const text = String(body.text ?? "").trim();
      const result = compileStrategy(text, text ? parseWithRules(text) : null, "rules");
      return json({ ...result, parserNote: "Demo: parsed by GapPilot's rule-based parser (the AI parser runs on the server)." });
    }

    case "POST /api/trade/simulate": {
      const o = verifiedOpportunity(body as never);
      if (!o) return fail("invalid", "This opportunity was not produced by this server, or it was modified.");
      const rules = rulesOf(body.rules);
      const strategy = strategyOf(body.strategy);
      const preview = await buildTradePreview({ client, opportunity: o, wallet: String(body.wallet), rules, strategy, quoteTokenAddress: DEMO_USDT });
      return json({ ok: true, data: attachPlanToken(preview, DEMO_SECRET, { rules, strategy, strategyName: (body.strategyName as string) ?? null }) });
    }

    case "POST /api/trade/approve": {
      if (body.confirm !== true) return fail("not_confirmed", "Approval needs an explicit confirmation.");
      const o = verifiedOpportunity(body as never);
      if (!o) return fail("invalid", "This opportunity was not produced by this server, or it was modified.");
      const preview = body.preview as TradePreview;
      const outcome = approvePlan({ planToken: String(body.planToken), confirm: body.confirm, wallet: String(body.wallet), secret: DEMO_SECRET, now: Date.now(), preview });
      if (!outcome.ok) return fail(outcome.reason, outcome.message, outcome.reason === "expired" ? 410 : 400);
      const { claims } = outcome.approval;
      const record = await executeWithAuthorization({
        provider: new MockExecutionProvider(),
        preview,
        opportunity: o,
        rules: claims.rules,
        strategy: claims.strategy,
        strategyName: claims.strategyName,
        authorization: { type: "USER_APPROVED", approvalId: outcome.approval.approvalId, approvedAt: outcome.approval.approvedAt },
        quoteTokenAddress: DEMO_USDT,
        audit,
        now: Date.now,
      });
      settle(record, preview.side);
      return json({ ok: true, data: record });
    }

    case "POST /api/autonomy/grant": {
      const strategy = strategyOf(body.strategy);
      if (!strategy || body.consent !== true) return fail("validation", "A valid strategy and explicit consent are required.");
      const created = createGrant({
        strategy,
        strategyName: String(body.strategyName ?? "Strategy"),
        maxTradeUsd: Number(body.maxTradeUsd),
        maxTradesPerDay: Number(body.maxTradesPerDay),
        maxDailyUsd: Number(body.maxDailyUsd),
        durationMs: Number(body.durationHours) * 3_600_000,
        provider: "mock",
        now: Date.now(),
      });
      if (!created.ok) return fail("validation", created.message);
      return json({ ok: true, data: { grant: created.grant, grantToken: signGrant(created.grant, DEMO_SECRET) } });
    }

    case "POST /api/autonomy/run": {
      const grant = AutonomyGrantSchema.safeParse(verifyGrantToken(String(body.grantToken), DEMO_SECRET));
      const strategy = strategyOf(body.strategy);
      if (!grant.success || !strategy) return fail("invalid_grant", "This grant wasn't issued by this server or was modified.");
      const result = await runAutonomousCycle({
        client,
        provider: new MockExecutionProvider({ wallet: String(body.wallet) }),
        grant: grant.data,
        strategy,
        strategyName: grant.data.strategyName,
        rules: rulesOf(body.rules),
        quoteTokenAddress: DEMO_USDT,
        audit,
      });
      for (const r of result.records) settle(r, r.signal?.direction === "DISCOUNT" ? "BUY" : r.signal?.direction === "PREMIUM" ? "SELL" : null);
      return json({ ok: true, data: { ...result, mode: "SIMULATED" } });
    }

    default:
      return fail("not_found", `No demo handler for ${method} ${path}`, 404);
  }
}
