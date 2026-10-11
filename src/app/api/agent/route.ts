import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/lib/config/env";
import { verifyAttestation } from "@/lib/assessment/attestation";
import { runAgent } from "@/lib/agent/agent";
import { DEFAULT_USER_RULES, UserRulesSchema, type AgentOutput } from "@/lib/agent/types";
import type { Opportunity } from "@/lib/engine/types";
import { getLogger } from "@/lib/logging/server-logger";
import { clientKey, createRateLimiter } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const deterministicLimiter = createRateLimiter({ limit: 120, windowMs: 60_000 });
const narrateLimiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
const cache = new Map<string, { at: number; out: AgentOutput }>();
const MAX_AGE_MS = 15 * 60_000;

const Body = z.object({
  /** Exactly JSON.stringify(opportunity) as received from /api/opportunities. */
  opportunity: z.string().min(2).max(64_000),
  attestation: z.string().min(16).max(128),
  rules: UserRulesSchema.optional(),
  /** Ask the LLM for a verified summary (and stricter-only proposals). */
  narrate: z.boolean().optional(),
});

/**
 * POST /api/agent — the reasoning agent for ONE engine opportunity.
 * Accepts only opportunities this server signed. Returns advice (WAIT /
 * SIMULATE / NO_ACTION); there is no code path here that builds or sends a transaction.
 */
export async function POST(request: Request) {
  let env;
  try {
    env = getServerEnv();
  } catch {
    return NextResponse.json({ ok: false, error: { kind: "config", message: "Server is not configured." } }, { status: 500 });
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "Body must be JSON";
    return NextResponse.json({ ok: false, error: { kind: "validation", message: msg } }, { status: 400 });
  }

  const rl = (body.narrate ? narrateLimiter : deterministicLimiter).check(clientKey(request));
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: { kind: "rate_limited", message: `Too many requests. Try again in ${rl.retryAfterSec} s.` } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  if (!verifyAttestation(body.opportunity, body.attestation, env.BINANCE_WEB3_API_SECRET)) {
    return NextResponse.json(
      { ok: false, error: { kind: "invalid", message: "This opportunity was not produced by this server, or it was modified." } },
      { status: 400 },
    );
  }
  const opportunity = JSON.parse(body.opportunity) as Opportunity;
  if (Date.now() - opportunity.evaluatedAt > MAX_AGE_MS) {
    return NextResponse.json({ ok: false, error: { kind: "expired", message: "This scan is older than 15 minutes. Rescan first." } }, { status: 410 });
  }

  const rules = body.rules ?? DEFAULT_USER_RULES;
  const key = `${body.attestation}|${JSON.stringify(rules)}|${body.narrate ? 1 : 0}`;
  const hit = cache.get(key);
  const out =
    hit && Date.now() - hit.at < MAX_AGE_MS
      ? hit.out
      : await runAgent(opportunity, rules, body.narrate ? { narrate: { apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL } } : {});
  if (!hit && (out.guardrails.llm === "verified" || out.guardrails.llm === "rejected" || out.guardrails.llm === "not_requested")) {
    cache.set(key, { at: Date.now(), out });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }

  const g = out.guardrails;
  const log = getLogger();
  if (g.clamped.length) log.warn("agent.clamped", { symbol: out.asset.symbol, clamped: g.clamped });
  if (g.llm === "rejected" || g.llm === "error") log.warn("agent.llm_fallback", { symbol: out.asset.symbol, llm: g.llm, detail: g.llmDetail });

  return NextResponse.json({ ok: true, data: out }, { headers: { "Cache-Control": "no-store" } });
}
