import { NextResponse } from "next/server";
import { z } from "zod";
import { evmAddress } from "@/lib/binance/validation";
import { getServerEnv } from "@/lib/config/env";
import { verifyAttestation } from "@/lib/assessment/attestation";
import type { Opportunity } from "@/lib/engine/types";
import { executeWithAuthorization } from "@/lib/execution/runner";
import { webAuditLog, webExecutionProvider } from "@/lib/execution/server";
import { approvePlan } from "@/lib/trade/approval";
import type { TradePreview } from "@/lib/trade/types";
import { getLogger } from "@/lib/logging/server-logger";
import { clientKey, createRateLimiter } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 20, windowMs: 60_000 });
const Body = z.object({
  planToken: z.string().min(20).max(8_000),
  wallet: evmAddress,
  /** Must be literally true: the user ticked the box and pressed Confirm. */
  confirm: z.literal(true),
  /** The exact preview that was simulated (hash-checked against the plan token). */
  preview: z.record(z.string(), z.unknown()),
  opportunity: z.string().min(2).max(64_000),
  attestation: z.string().min(16).max(128),
});

/**
 * POST /api/trade/approve — the user's explicit approval of a PASSED,
 * unexpired simulation, executed through the configured provider. In the web
 * app that is always SIMULATED (mock) execution; live Agentic Wallet execution
 * is refused here and runs only in the local agent worker.
 */
export async function POST(request: Request) {
  const rl = limiter.check(clientKey(request));
  if (!rl.allowed) return NextResponse.json({ ok: false, error: { kind: "rate_limited", message: "Too many requests." } }, { status: 429 });
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
    return NextResponse.json({ ok: false, error: { kind: "not_confirmed", message: "Approval needs { planToken, wallet, confirm: true, preview, opportunity, attestation }." } }, { status: 400 });
  }
  if (!verifyAttestation(body.opportunity, body.attestation, env.BINANCE_WEB3_API_SECRET)) {
    return NextResponse.json({ ok: false, error: { kind: "invalid", message: "This opportunity was not produced by this server, or it was modified." } }, { status: 400 });
  }
  const preview = body.preview as unknown as TradePreview;
  const now = Date.now();
  const outcome = approvePlan({ planToken: body.planToken, confirm: body.confirm, wallet: body.wallet, secret: env.BINANCE_WEB3_API_SECRET, now, preview });
  if (!outcome.ok) {
    return NextResponse.json({ ok: false, error: { kind: outcome.reason, message: outcome.message } }, { status: outcome.reason === "expired" ? 410 : 400 });
  }

  const { claims } = outcome.approval;
  const record = await executeWithAuthorization({
    provider: webExecutionProvider(env),
    preview,
    opportunity: JSON.parse(body.opportunity) as Opportunity,
    rules: claims.rules,
    strategy: claims.strategy,
    strategyName: claims.strategyName,
    authorization: { type: "USER_APPROVED", approvalId: outcome.approval.approvalId, approvedAt: outcome.approval.approvedAt },
    quoteTokenAddress: env.GAPPILOT_QUOTE_TOKEN_ADDRESS,
    audit: webAuditLog(),
    now: Date.now,
  });
  getLogger().info("trade.executed", { auditId: record.id, mode: record.mode, provider: record.provider, result: record.result, violations: record.authorization.violations.map((v) => v.code) });
  return NextResponse.json({ ok: true, data: record });
}
