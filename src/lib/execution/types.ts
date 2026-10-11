/**
 * Execution layer types.
 *
 * Every execution goes through ONE deterministic authorization step
 * (policy.ts) and ONE provider. Providers are interchangeable:
 *   - MockExecutionProvider        → mode "SIMULATED": nothing leaves GapPilot.
 *   - BinanceAgenticWalletProvider → mode "LIVE": real orders via the `baw` CLI,
 *                                    local agent worker only, off by default.
 */
import { z } from "zod";

export type ExecutionMode = "SIMULATED" | "LIVE";
export type ProviderId = "mock" | "binance-agentic-wallet";

/** What a provider is asked to do. Built server-side from a PASSED preview; never from client input. */
export interface ExecutionRequest {
  requestId: string;
  /** Spot only. There is no other kind, by construction. */
  kind: "SPOT_SWAP";
  chainId: "56";
  side: "BUY" | "SELL";
  wallet: string;
  asset: { address: string; symbol: string; issuer: string; underlyingTicker: string };
  input: { address: string; symbol: string; decimals: number; raw: string; usd: number | null };
  output: { address: string; symbol: string; decimals: number; expectedRaw: string; minimumRaw: string };
  /** Executed with exactly this slippage; providers may not substitute "auto". */
  slippageLimitPercent: number;
  quoteId: string | null;
  previewHash: string;
  expiresAt: number;
}

export interface ExecutionResult {
  mode: ExecutionMode;
  provider: ProviderId;
  status: "FILLED" | "FILLED_BELOW_MINIMUM" | "FAILED" | "PENDING";
  orderId: string | null;
  /** Real 0x hash for LIVE; "SIMULATED-…" for SIMULATED (never a 0x value). */
  txHash: string | null;
  actualOutputRaw: string | null;
  detail: string;
}

export interface ProviderPreflight {
  ready: boolean;
  wallet: string | null;
  /** Remaining daily trading quota in USD as reported by the wallet, if any. */
  quotaLeftUsd: number | null;
  detail: string;
}

export interface ExecutionProvider {
  readonly id: ProviderId;
  readonly mode: ExecutionMode;
  /** Checks the provider can act (session, version, lock, quota). Must not trade. */
  preflight(request?: ExecutionRequest): Promise<ProviderPreflight>;
  /** Executes an AUTHORIZED request. Implementations must re-check authorization. */
  execute(request: ExecutionRequest, authorization: AuthorizationProof): Promise<ExecutionResult>;
}

/** Autonomous authorization: what the user granted the agent, bound to one exact strategy. */
export const AutonomyGrantSchema = z
  .object({
    v: z.literal(1),
    grantId: z.string().min(8).max(64),
    /** sha256 of the canonical strategy JSON; the grant only covers that exact strategy. */
    strategyHash: z.string().regex(/^[0-9a-f]{64}$/),
    strategyName: z.string().max(120),
    /** ≤ the strategy's own maximumTradeUsd (checked at creation and at execution). */
    maxTradeUsd: z.number().positive().max(10_000),
    maxTradesPerDay: z.number().int().min(1).max(20),
    maxDailyUsd: z.number().positive().max(50_000),
    provider: z.enum(["mock", "binance-agentic-wallet"]),
    createdAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .refine((g) => g.expiresAt > g.createdAt && g.expiresAt - g.createdAt <= 7 * 86_400_000, { message: "grant must expire within 7 days", path: ["expiresAt"] })
  .refine((g) => g.maxDailyUsd >= g.maxTradeUsd, { message: "daily cap must be at least one trade", path: ["maxDailyUsd"] });
export type AutonomyGrant = z.infer<typeof AutonomyGrantSchema>;

export type Authorization =
  | { type: "USER_APPROVED"; approvalId: string; approvedAt: number }
  | { type: "AUTONOMOUS_GRANT"; grant: AutonomyGrant };

/** Proof handed to providers: the authorization plus the policy verdict for THIS request. */
export interface AuthorizationProof {
  authorization: Authorization;
  requestId: string;
  previewHash: string;
  authorizedAt: number;
  verdict: "AUTHORIZED";
}

export type ViolationCode =
  | "NO_AUTHORIZATION"
  | "SIMULATION_NOT_PASSED"
  | "PLAN_EXPIRED"
  | "TRADE_SIZE_EXCEEDS_LIMIT"
  | "SLIPPAGE_EXCEEDS_LIMIT"
  | "UNSUPPORTED_ASSET"
  | "LEVERAGE_OR_DERIVATIVES"
  | "WALLET_MISMATCH"
  | "WALLET_SAFETY"
  | "AGENT_NOT_EXECUTABLE"
  | "STRATEGY_MISMATCH"
  | "GRANT_INVALID"
  | "GRANT_EXPIRED"
  | "DAILY_LIMIT"
  | "DUPLICATE"
  | "PROVIDER_NOT_READY"
  | "PROVIDER_QUOTA";

export interface Violation {
  code: ViolationCode;
  message: string;
}

export interface AuditRecord {
  id: string;
  timestamp: number;
  mode: ExecutionMode;
  provider: ProviderId;
  asset: { symbol: string; address: string; issuer: string; underlyingTicker: string } | null;
  strategy: { name: string; hash: string } | null;
  signal: {
    direction: string;
    spreadPercent: number;
    referenceKind: string;
    referenceSource: string;
    engineAction: string;
    agentDecision: string;
  } | null;
  quote: {
    quoteId: string | null;
    vendor: string | null;
    executionMode: string | null;
    input: string | null;
    /** Numeric USD size of the input, used for daily-cap accounting. */
    inputUsd: number | null;
    expectedOutput: string | null;
    minimumOutput: string | null;
    slippageLimitPercent: number | null;
  } | null;
  simulation: { status: string; transactions: Array<{ kind: string; status: string }>; failureReason: string | null } | null;
  authorization: {
    state: "USER_APPROVED" | "AUTONOMOUS_GRANT" | "NONE";
    approvalId: string | null;
    grantId: string | null;
    verdict: "AUTHORIZED" | "REFUSED";
    violations: Violation[];
  };
  execution: { status: ExecutionResult["status"] | "NOT_ATTEMPTED"; orderId: string | null; txHash: string | null; actualOutputRaw: string | null; detail: string };
  result: "FILLED" | "SIMULATED_FILL" | "FILLED_BELOW_MINIMUM" | "FAILED" | "REFUSED" | "PENDING";
  /** Hash chain: sha256 of the previous record's hash + this record's content. */
  prevHash: string | null;
  hash: string;
}
