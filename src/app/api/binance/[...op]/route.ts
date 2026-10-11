import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getServerEnv } from "@/lib/config/env";
import { getBinanceClient } from "@/lib/binance/client";
import { OPERATIONS, runOperation } from "@/lib/binance/server/operations";
import { getLogger } from "@/lib/logging/server-logger";

export const runtime = "nodejs"; // signing uses node:crypto
export const dynamic = "force-dynamic";

/**
 * Integration routes: /api/binance/<module>/<operation>
 *   e.g. GET /api/binance/rwa/discover
 *        GET /api/binance/rwa/asset?address=0x...
 *
 * Secrets never leave the server: the browser receives sanitized JSON only.
 * Development: open. Production: 404 unless GAPPILOT_DEBUG_ROUTES_TOKEN is set
 * and the request sends `Authorization: Bearer <token>`.
 */

function authorised(request: Request): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const expected = getServerEnv().GAPPILOT_DEBUG_ROUTES_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handle(request: Request, params: Promise<{ op: string[] }>) {
  if (!authorised(request)) return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });

  const name = (await params).op.join("/");
  const log = getLogger().child({ route: "api/binance", op: name });

  if (name === "" || name === "index") {
    return NextResponse.json({
      ok: true,
      operations: Object.entries(OPERATIONS).map(([k, v]) => ({ op: k, method: v.method, description: v.description })),
    });
  }

  let input: unknown;
  if (request.method === "GET") {
    input = Object.fromEntries(new URL(request.url).searchParams);
  } else {
    try {
      input = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, op: name, error: { kind: "validation", message: "Body must be JSON" } },
        { status: 400 },
      );
    }
  }

  let client;
  try {
    client = getBinanceClient();
  } catch (err) {
    log.error("api.config_error", { message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ ok: false, op: name, error: { kind: "config", message: "Server is not configured" } }, { status: 500 });
  }

  const { status, body } = await runOperation(client, name, request.method, input, {
    quoteTokenAddress: getServerEnv().GAPPILOT_QUOTE_TOKEN_ADDRESS,
  });
  log.info("api.response", { status, ok: body.ok, kind: body.ok ? undefined : body.error.kind });
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: Request, ctx: { params: Promise<{ op: string[] }> }) {
  return handle(request, ctx.params);
}

export async function POST(request: Request, ctx: { params: Promise<{ op: string[] }> }) {
  return handle(request, ctx.params);
}
