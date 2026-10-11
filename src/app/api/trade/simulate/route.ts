import { NextResponse } from "next/server";
import { z } from "zod";
import { getBinanceClient } from "@/lib/binance/client";
import { evmAddress } from "@/lib/binance/validation";
import { getServerEnv } from "@/lib/config/env";
import { verifyAttestation } from "@/lib/assessment/attestation";
import { DEFAULT_USER_RULES, UserRulesSchema } from "@/lib/agent/types";
import type { Opportunity } from "@/lib/engine/types";
import { StrategySchema } from "@/lib/strategy/schema";
import { buildTradePreview } from "@/lib/trade/planner";
import { attachPlanToken } from "@/lib/trade/approval";
import { getLogger } from "@/lib/logging/server-logger";
import { clientKey, createRateLimiter } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });
const Body = z.object({
  opportunity: z.string().min(2).max(64_000),
  attestation: z.string().min(16).max(128),
  wallet: evmAddress,
  rules: UserRulesSchema.optional(),
  strategy: StrategySchema.nullable().optional(),
  strategyName: z.string().max(120).nullable().optional(),
});

/**
 * POST /api/trade/simulate — builds and SIMULATES a trade for review.
 * Quote → Binance-built transactions → Transaction API simulation. Never signs or sends.
 */
export async function POST(request: Request) {
  const rl = limiter.check(clientKey(request));
  if (!rl.allowed) return NextResponse.json({ ok: false, error: { kind: "rate_limited", message: `Too many simulations. Try again in ${rl.retryAfterSec} s.` } }, { status: 429 });

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
    return NextResponse.json({ ok: false, error: { kind: "validation", message: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "Body must be JSON" } }, { status: 400 });
  }
  if (!verifyAttestation(body.opportunity, body.attestation, env.BINANCE_WEB3_API_SECRET)) {
    return NextResponse.json({ ok: false, error: { kind: "invalid", message: "This opportunity was not produced by this server, or it was modified." } }, { status: 400 });
  }
  const opportunity = JSON.parse(body.opportunity) as Opportunity;
  if (Date.now() - opportunity.evaluatedAt > 5 * 60_000) {
    return NextResponse.json({ ok: false, error: { kind: "expired", message: "This scan is more than 5 minutes old. Rescan before simulating." } }, { status: 410 });
  }

  const preview = await buildTradePreview({
    client: getBinanceClient(),
    opportunity,
    wallet: body.wallet,
    rules: body.rules ?? DEFAULT_USER_RULES,
    strategy: body.strategy ?? null,
    quoteTokenAddress: env.GAPPILOT_QUOTE_TOKEN_ADDRESS,
  });
  const signed = attachPlanToken(preview, env.BINANCE_WEB3_API_SECRET, {
    rules: body.rules ?? DEFAULT_USER_RULES,
    strategy: body.strategy ?? null,
    strategyName: body.strategyName ?? null,
  });
  getLogger().info("trade.simulated", {
    symbol: opportunity.asset.symbol,
    status: signed.status,
    mode: signed.route.executionMode,
    failure: signed.failureReason,
    simulations: signed.transactions.map((t) => `${t.kind}:${t.simulation?.status ?? "none"}`),
  });
  return NextResponse.json({ ok: true, data: signed }, { headers: { "Cache-Control": "no-store" } });
}
