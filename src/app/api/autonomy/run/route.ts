import { NextResponse } from "next/server";
import { z } from "zod";
import { getBinanceClient } from "@/lib/binance/client";
import { evmAddress } from "@/lib/binance/validation";
import { getServerEnv } from "@/lib/config/env";
import { DEFAULT_USER_RULES, UserRulesSchema } from "@/lib/agent/types";
import { MockExecutionProvider } from "@/lib/execution/mock-provider";
import { runAutonomousCycle } from "@/lib/execution/runner";
import { webAuditLog } from "@/lib/execution/server";
import { AutonomyGrantSchema } from "@/lib/execution/types";
import { StrategySchema } from "@/lib/strategy/schema";
import { verifyGrantToken } from "@/lib/trade/approval";
import { getLogger } from "@/lib/logging/server-logger";
import { clientKey, createRateLimiter } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 6, windowMs: 60_000 });
const Body = z.object({
  grantToken: z.string().min(20).max(8_000),
  strategy: StrategySchema,
  rules: UserRulesSchema.optional(),
  /** Wallet whose balances the simulated execution acts on (the user's connected wallet). */
  wallet: evmAddress,
});

/**
 * POST /api/autonomy/run — one autonomous cycle in the web demo, ALWAYS with
 * the MockExecutionProvider (SIMULATED). Live autonomous execution exists only
 * in the local agent worker (`npm run agent`).
 */
export async function POST(request: Request) {
  const rl = limiter.check(clientKey(request));
  if (!rl.allowed) return NextResponse.json({ ok: false, error: { kind: "rate_limited", message: "Too many runs. Wait a minute." } }, { status: 429 });
  let env;
  try {
    env = getServerEnv();
  } catch {
    return NextResponse.json({ ok: false, error: { kind: "config", message: "Server is not configured." } }, { status: 500 });
  }
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ ok: false, error: { kind: "validation", message: "Expected { grantToken, strategy, rules?, wallet }." } }, { status: 400 });
  }
  const grant = AutonomyGrantSchema.safeParse(verifyGrantToken(body.grantToken, env.BINANCE_WEB3_API_SECRET));
  if (!grant.success) return NextResponse.json({ ok: false, error: { kind: "invalid_grant", message: "This grant wasn't issued by this server or was modified." } }, { status: 400 });

  try {
    const result = await runAutonomousCycle({
      client: getBinanceClient(),
      provider: new MockExecutionProvider({ wallet: body.wallet }),
      grant: grant.data,
      strategy: body.strategy,
      strategyName: grant.data.strategyName,
      rules: body.rules ?? DEFAULT_USER_RULES,
      quoteTokenAddress: env.GAPPILOT_QUOTE_TOKEN_ADDRESS,
      audit: webAuditLog(),
    });
    getLogger().info("autonomy.cycle", { grantId: grant.data.grantId, scanned: result.scanned, candidates: result.candidates.length, results: result.records.map((r) => r.result) });
    return NextResponse.json({ ok: true, data: { ...result, mode: "SIMULATED" } });
  } catch (e) {
    return NextResponse.json({ ok: false, error: { kind: "cycle_failed", message: e instanceof Error ? e.message : "The cycle failed." } }, { status: 502 });
  }
}
