import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/lib/config/env";
import { createGrant } from "@/lib/execution/policy";
import { StrategySchema } from "@/lib/strategy/schema";
import { signGrant } from "@/lib/trade/approval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({
  strategy: StrategySchema,
  strategyName: z.string().min(1).max(120),
  maxTradeUsd: z.number().positive(),
  maxTradesPerDay: z.number().int().min(1).max(20),
  maxDailyUsd: z.number().positive(),
  durationHours: z.number().positive().max(168),
  /** The user's explicit consent to autonomous (simulated) execution. */
  consent: z.literal(true),
});

/**
 * POST /api/autonomy/grant — issues a signed autonomous-execution grant bound
 * to one exact strategy. The per-trade limit can't exceed the strategy's.
 * Web grants always use the mock provider (SIMULATED execution).
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
    return NextResponse.json({ ok: false, error: { kind: "validation", message: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : "Body must be JSON" } }, { status: 400 });
  }
  const created = createGrant({
    strategy: body.strategy,
    strategyName: body.strategyName,
    maxTradeUsd: body.maxTradeUsd,
    maxTradesPerDay: body.maxTradesPerDay,
    maxDailyUsd: body.maxDailyUsd,
    durationMs: body.durationHours * 3_600_000,
    provider: "mock",
    now: Date.now(),
  });
  if (!created.ok) return NextResponse.json({ ok: false, error: { kind: "validation", message: created.message } }, { status: 400 });
  return NextResponse.json({ ok: true, data: { grant: created.grant, grantToken: signGrant(created.grant, env.BINANCE_WEB3_API_SECRET) } });
}
