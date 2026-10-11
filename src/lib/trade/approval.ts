/**
 * Explicit user approval and signed tokens.
 *
 * A plan token is issued ONLY for a PASSED preview. It binds the exact preview
 * (by hash), the wallet, the quote and an expiry (quote TTL). Approval needs
 * that token plus an explicit `confirm: true` from the user, before expiry.
 *
 * Execution itself goes through src/lib/execution (policy + provider + audit).
 */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { TradePreview } from "./types";
import type { UserRules } from "../agent/types";
import type { Strategy } from "../strategy/schema";

const PLAN_CONTEXT = "gappilot:trade-plan:v1";

const key = (secret: string, ctx: string) => createHmac("sha256", secret).update(ctx).digest();
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url").toString("utf8");

function sign(payload: object, secret: string, ctx: string): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${createHmac("sha256", key(secret, ctx)).update(body).digest("base64url")}`;
}

function verify<T>(token: string, secret: string, ctx: string): T | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = Buffer.from(createHmac("sha256", key(secret, ctx)).update(body).digest("base64url"));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    return JSON.parse(unb64(body)) as T;
  } catch {
    return null;
  }
}

/** Hash of everything the user is shown (excluding the token itself). */
export function previewHash(p: TradePreview): string {
  const { planToken: _omit, ...rest } = p;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex");
}

export interface PlanClaims {
  v: 1;
  planHash: string;
  wallet: string;
  quoteId: string | null;
  side: "BUY" | "SELL";
  inputRaw: string;
  inputToken: string;
  outputToken: string;
  minimumOutputRaw: string | null;
  expiresAt: number;
  /** The limits the preview was simulated under; approval can't swap in looser ones. */
  rules: UserRules;
  strategy: Strategy | null;
  strategyName: string | null;
}

/** Attaches a plan token if, and only if, the preview PASSED. */
export function attachPlanToken(p: TradePreview, secret: string, limits: { rules: UserRules; strategy: Strategy | null; strategyName?: string | null }): TradePreview {
  if (p.status !== "PASSED" || !p.input || !p.expectedOutput) return { ...p, planToken: null };
  const claims: PlanClaims = {
    v: 1,
    planHash: previewHash({ ...p, planToken: null }),
    wallet: p.wallet.toLowerCase(),
    quoteId: p.quoteId,
    side: p.side,
    inputRaw: p.input.raw,
    inputToken: p.input.address,
    outputToken: p.expectedOutput.address,
    minimumOutputRaw: p.minimumOutput?.raw ?? null,
    expiresAt: p.expiresAt,
    rules: limits.rules,
    strategy: limits.strategy,
    strategyName: limits.strategyName ?? null,
  };
  return { ...p, planToken: sign(claims, secret, PLAN_CONTEXT) };
}

export type ApprovalOutcome =
  | { ok: true; approval: { approvalId: string; approvedAt: number; expiresAt: number; claims: PlanClaims } }
  | { ok: false; reason: "invalid_token" | "expired" | "not_confirmed" | "wallet_mismatch" | "preview_mismatch"; message: string };

/**
 * Explicit user approval of a PASSED, unexpired plan. If the full preview is
 * supplied, it must be byte-for-byte the one that was simulated (hash match).
 */
export function approvePlan(args: { planToken: string; confirm: unknown; wallet: string; secret: string; now: number; preview?: TradePreview }): ApprovalOutcome {
  if (args.confirm !== true) return { ok: false, reason: "not_confirmed", message: "Approval needs an explicit confirmation." };
  const claims = verify<PlanClaims>(args.planToken, args.secret, PLAN_CONTEXT);
  if (!claims || claims.v !== 1) return { ok: false, reason: "invalid_token", message: "This trade plan wasn't issued by this server or was modified." };
  if (args.now > claims.expiresAt) return { ok: false, reason: "expired", message: "The quote expired. Simulate again for a fresh quote." };
  if (claims.wallet !== args.wallet.toLowerCase()) return { ok: false, reason: "wallet_mismatch", message: "This plan was built for a different wallet." };
  if (args.preview && previewHash({ ...args.preview, planToken: null }) !== claims.planHash) {
    return { ok: false, reason: "preview_mismatch", message: "The trade details don't match what was simulated." };
  }
  return { ok: true, approval: { approvalId: randomUUID(), approvedAt: args.now, expiresAt: claims.expiresAt, claims } };
}

/** HMAC-signed autonomous grant (web demo). The local worker reads grants from its own bundle file. */
const GRANT_CONTEXT = "gappilot:autonomy-grant:v1";
export function signGrant(grant: object, secret: string): string {
  return sign(grant, secret, GRANT_CONTEXT);
}
export function verifyGrantToken<T>(token: string, secret: string): T | null {
  return verify<T>(token, secret, GRANT_CONTEXT);
}
