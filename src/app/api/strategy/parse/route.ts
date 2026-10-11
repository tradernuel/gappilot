import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerEnv } from "@/lib/config/env";
import { compileStrategy } from "@/lib/strategy/compile";
import { parseWithLlm } from "@/lib/strategy/llm-parser";
import { parseWithRules } from "@/lib/strategy/rules-parser";
import { STRATEGY_LIMITS, type CompileResult } from "@/lib/strategy/schema";
import { getLogger } from "@/lib/logging/server-logger";
import { clientKey, createRateLimiter } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = createRateLimiter({ limit: 15, windowMs: 60_000 });
const Body = z.object({ text: z.string().max(STRATEGY_LIMITS.maxTextLength * 2) });

/**
 * POST /api/strategy/parse { text } → CompileResult
 * Parses a rule (LLM if configured, else rule-based) and compiles it
 * deterministically. Parse-only: saves nothing and executes nothing.
 */
export async function POST(request: Request) {
  const rl = limiter.check(clientKey(request));
  if (!rl.allowed) {
    return NextResponse.json({ ok: false, error: { kind: "rate_limited", message: `Too many requests. Try again in ${rl.retryAfterSec} s.` } }, { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } });
  }
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await request.json());
  } catch {
    return NextResponse.json({ ok: false, error: { kind: "validation", message: "Expected { text }." } }, { status: 400 });
  }

  let apiKey: string | undefined;
  let model: string | undefined;
  try {
    const env = getServerEnv();
    apiKey = env.OPENAI_API_KEY;
    model = env.OPENAI_MODEL;
  } catch {
    /* Strategy parsing needs no Binance config; fall back to rules if env is incomplete. */
  }

  const text = body.text.trim();
  let result: CompileResult;
  let parserNote: string | undefined;
  if (apiKey && model && text && text.length <= STRATEGY_LIMITS.maxTextLength) {
    const llm = await parseWithLlm(text, { apiKey, model });
    if (llm.status === "ok") {
      result = compileStrategy(text, llm.extraction, "llm");
      parserNote = `Parsed by ${llm.model}; every value was checked against your text.`;
    } else {
      result = compileStrategy(text, parseWithRules(text), "rules");
      parserNote = "The AI parser was unavailable, so the rule-based parser was used.";
      safeLog("strategy.llm_fallback", { detail: llm.detail });
    }
  } else {
    result = compileStrategy(text, text ? parseWithRules(text) : null, "rules");
    parserNote = "Parsed by GapPilot's rule-based parser.";
  }

  safeLog("strategy.parsed", { ok: result.ok, parser: result.parser, errors: result.errors.map((e) => e.code) });
  return NextResponse.json({ ...result, parserNote }, { headers: { "Cache-Control": "no-store" } });
}

function safeLog(msg: string, fields: Record<string, unknown>) {
  try {
    getLogger().info(msg, fields);
  } catch {
    /* logger needs env; ignore */
  }
}
