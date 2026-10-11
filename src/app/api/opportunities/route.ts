import { NextResponse } from "next/server";
import { BinanceApiError } from "@/lib/binance/errors";
import { statusForError } from "@/lib/binance/server/operations";
import { getLogger } from "@/lib/logging/server-logger";
import { clientKey, createRateLimiter } from "@/lib/server/rate-limit";
import { ScanQuery, scanForDashboard } from "@/lib/server/opportunities";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

/**
 * GET /api/opportunities?notional=100&wallet=0x...&maxPairs=10
 * Public endpoint for the dashboard. Read-only, rate-limited, cached 15 s.
 */
export async function GET(request: Request) {
  const rl = limiter.check(clientKey(request));
  if (!rl.allowed) {
    return NextResponse.json(
      { ok: false, error: { kind: "rate_limited", message: `Too many scans. Try again in ${rl.retryAfterSec} s.` } },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  const parsed = ScanQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: { kind: "validation", message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") } },
      { status: 400 },
    );
  }

  const log = getLoggerSafe();
  try {
    const data = await scanForDashboard(parsed.data);
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof Error && /Invalid GapPilot environment/.test(err.message)) {
      log?.error("opportunities.config_error", { message: err.message });
      return NextResponse.json(
        { ok: false, error: { kind: "config", message: "The server is missing its Binance API configuration." } },
        { status: 500 },
      );
    }
    const e = err instanceof BinanceApiError ? err : undefined;
    log?.error("opportunities.failed", { kind: e?.kind, httpStatus: e?.httpStatus, code: e?.code, message: e?.message });
    return NextResponse.json(
      {
        ok: false,
        error: {
          kind: e?.kind ?? "internal",
          message: e?.message ?? "The scan failed unexpectedly.",
          upstreamStatus: e?.httpStatus,
          code: e?.code,
        },
      },
      { status: statusForError(err) },
    );
  }
}

function getLoggerSafe() {
  try {
    return getLogger();
  } catch {
    return undefined;
  }
}
