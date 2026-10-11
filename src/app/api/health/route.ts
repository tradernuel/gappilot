import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/config/env";
import { getBinanceClient } from "@/lib/binance/client";
import { BinanceApiError } from "@/lib/binance/errors";

export const runtime = "nodejs"; // HMAC signing uses node:crypto
export const dynamic = "force-dynamic";

/**
 * GET /api/health            → config check only (no outbound calls)
 * GET /api/health?probe=1    → also makes one signed call (GET /rwa/platforms)
 *
 * Never returns secrets or raw upstream bodies.
 */
export async function GET(request: Request) {
  let env;
  try {
    env = getServerEnv();
  } catch (err) {
    return NextResponse.json(
      { ok: false, stage: "config", error: err instanceof Error ? err.message : "invalid config" },
      { status: 500 },
    );
  }

  const result: Record<string, unknown> = {
    ok: true,
    stage: "config",
    baseUrl: env.BINANCE_WEB3_BASE_URL,
    executionEnabled: env.GAPPILOT_EXECUTION_ENABLED,
    referenceProvider: env.GAPPILOT_REFERENCE_PROVIDER,
    openAiConfigured: Boolean(env.OPENAI_API_KEY && env.OPENAI_MODEL),
  };

  if (new URL(request.url).searchParams.get("probe") !== "1") {
    return NextResponse.json(result);
  }

  const started = Date.now();
  try {
    const { data, rateLimit, serverTime } = await getBinanceClient().rwa.platforms();
    return NextResponse.json({
      ...result,
      stage: "probe",
      latencyMs: Date.now() - started,
      clockSkewMs: serverTime ? Date.now() - serverTime : null,
      rateLimit,
      platforms: (data ?? []).map((p) => p.platformId),
    });
  } catch (err) {
    const status = err instanceof BinanceApiError && err.httpStatus ? err.httpStatus : 502;
    return NextResponse.json(
      {
        ...result,
        ok: false,
        stage: "probe",
        latencyMs: Date.now() - started,
        error:
          err instanceof BinanceApiError
            ? { kind: err.kind, httpStatus: err.httpStatus, code: err.code, message: err.message }
            : { message: err instanceof Error ? err.message : String(err) },
      },
      { status: status >= 400 && status < 600 ? status : 502 },
    );
  }
}
