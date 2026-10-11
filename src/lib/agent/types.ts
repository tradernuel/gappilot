/**
 * GapPilot reasoning agent — types.
 *
 * The agent reads ONE engine Opportunity (plus the user's rules) and returns a
 * recommendation. It has no access to market APIs, wallets, or transaction
 * builders: the types below contain no calldata, no amounts to sign, and no
 * way to express "execute".
 */
import { z } from "zod";
import type { ConfidenceLevel, OpportunityAction } from "../engine/types";

/** Same vocabulary as the engine. The agent may lower it, never raise it. */
export type AgentDecision = OpportunityAction;

/** Ordered least → most permissive. SIMULATE is the furthest the agent ever goes. */
export type RecommendedAction = "NO_ACTION" | "WAIT" | "SIMULATE";
export const ACTION_PERMISSIVENESS: Record<RecommendedAction, number> = { NO_ACTION: 0, WAIT: 1, SIMULATE: 2 };
export const DECISION_RANK: Record<AgentDecision, number> = { IGNORE: 0, WATCH: 1, ACTIONABLE: 2, EXECUTABLE: 3 };
export const CONFIDENCE_RANK: Record<ConfidenceLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * The user's own rules. They can only make the agent STRICTER than the engine:
 * the engine's caps are applied first and the agent can never exceed them.
 */
export const UserRulesSchema = z
  .object({
    /** Largest trade size the user will consider. */
    maxNotionalUsd: z.number().positive().max(1_000_000),
    /** Minimum estimated net edge after costs, in percent. */
    minNetEdgePercent: z.number().min(0).max(50),
    /** Maximum acceptable estimated slippage, in percent. */
    maxSlippagePercent: z.number().min(0).max(10),
    /** Maximum age of the reference price, in hours. */
    maxReferenceAgeHours: z.number().min(0).max(720),
    minConfidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    /** If false, nothing is executable while the underlying market is closed. */
    allowMarketClosed: z.boolean(),
  })
  .strict();
export type UserRules = z.infer<typeof UserRulesSchema>;

/** Conservative defaults. */
export const DEFAULT_USER_RULES: UserRules = {
  maxNotionalUsd: 1_000,
  minNetEdgePercent: 0.5,
  maxSlippagePercent: 0.5,
  maxReferenceAgeHours: 24,
  minConfidence: "MEDIUM",
  allowMarketClosed: true,
};

export type RuleCode =
  | "MAX_NOTIONAL"
  | "MIN_NET_EDGE"
  | "MAX_SLIPPAGE"
  | "MAX_REFERENCE_AGE"
  | "MIN_CONFIDENCE"
  | "MARKET_CLOSED";

export interface RuleCheck {
  rule: RuleCode;
  passed: boolean;
  detail: string;
}

export type RiskCode =
  | "DERIVED_REFERENCE"
  | "CORPORATE_ACTION"
  | "TOKEN_SAFETY"
  | "REFERENCE_STALE"
  | "DATA_FRESHNESS"
  | "EXECUTION_COST"
  | "LIQUIDITY"
  | "OFF_HOURS"
  | "TOKEN_TAX"
  | "ISSUER_STRUCTURE"
  | "PRICE_MOVEMENT";

export type Severity = "LOW" | "MEDIUM" | "HIGH";
export const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export interface AgentRisk {
  code: RiskCode;
  severity: Severity;
  text: string;
}

export type LlmStatus = "not_requested" | "not_configured" | "verified" | "rejected" | "error";

export interface AgentOutput {
  // ── Required contract ────────────────────────────────────────────────────
  decision: AgentDecision;
  confidence: ConfidenceLevel;
  summary: string;
  reasons: string[];
  risks: string[];
  recommendedAction: RecommendedAction;

  // ── Audit detail ─────────────────────────────────────────────────────────
  mainRisk: AgentRisk | null;
  riskDetails: AgentRisk[];
  executableUnderRules: boolean;
  ruleChecks: RuleCheck[];
  rules: UserRules;
  engineAction: OpportunityAction;
  engineConfidence: ConfidenceLevel;
  asset: { address: string; symbol: string; underlyingTicker: string; issuer: string };
  evaluatedAt: number;
  source: "deterministic" | "deterministic+llm_summary";
  guardrails: {
    /** Fields where an LLM proposal was less conservative and was clamped back. */
    clamped: Array<"decision" | "recommendedAction" | "confidence">;
    llm: LlmStatus;
    llmDetail?: string;
    model?: string;
  };
  disclaimer: string;
}
