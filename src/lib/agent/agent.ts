/**
 * GapPilot reasoning agent.
 *
 *   runAgent(opportunity, rules)                     → deterministic AgentOutput
 *   runAgent(opportunity, rules, { narrate: deps })  → + optional verified LLM summary
 *
 * Authority order: engine > deterministic policy > LLM. Each layer can only
 * keep or tighten the previous one. The agent has no access to market data,
 * wallets or transaction builders: it reads one Opportunity and returns advice.
 */
import "server-only";
import type { Opportunity } from "../engine/types";
import { runAgentDeterministic } from "./deterministic";
import { narrate } from "./narrator";
import {
  ACTION_PERMISSIVENESS,
  CONFIDENCE_RANK,
  DECISION_RANK,
  DEFAULT_USER_RULES,
  type AgentOutput,
  type UserRules,
} from "./types";

export { runAgentDeterministic };

export interface RunAgentOptions {
  narrate?: { apiKey?: string; model?: string; fetchImpl?: typeof fetch; timeoutMs?: number };
}

export async function runAgent(o: Opportunity, rules: UserRules = DEFAULT_USER_RULES, opts: RunAgentOptions = {}): Promise<AgentOutput> {
  const base = runAgentDeterministic(o, rules);
  if (!opts.narrate) return base;

  const result = await narrate(
    {
      opportunity: o,
      policy: {
        decision: base.decision,
        recommendedAction: base.recommendedAction,
        confidence: base.confidence,
        risks: base.riskDetails,
        mainRisk: base.mainRisk,
        ruleChecks: base.ruleChecks,
        rules,
        reasons: base.reasons,
        summary: base.summary,
      },
    },
    opts.narrate,
  );

  if (result.status === "not_configured") return { ...base, guardrails: { clamped: [], llm: "not_configured" } };
  if (result.status === "error") return { ...base, guardrails: { clamped: [], llm: "error", llmDetail: result.detail } };
  if (result.status === "rejected") return { ...base, guardrails: { clamped: [], llm: "rejected", llmDetail: result.detail, model: result.model } };

  // Verified: apply only equal-or-stricter proposals.
  const p = result.proposal;
  const clamped: AgentOutput["guardrails"]["clamped"] = [];
  let decision = base.decision;
  if (DECISION_RANK[p.decision] > DECISION_RANK[base.decision]) clamped.push("decision");
  else decision = p.decision;
  let recommendedAction = base.recommendedAction;
  if (ACTION_PERMISSIVENESS[p.recommendedAction] > ACTION_PERMISSIVENESS[base.recommendedAction]) clamped.push("recommendedAction");
  else recommendedAction = p.recommendedAction;
  let confidence = base.confidence;
  if (CONFIDENCE_RANK[p.confidence] > CONFIDENCE_RANK[base.confidence]) clamped.push("confidence");
  else confidence = p.confidence;

  // A stricter decision can't keep a more permissive action than the policy would give it.
  if (decision !== "EXECUTABLE" && recommendedAction === "SIMULATE") recommendedAction = "WAIT";
  if (decision === "IGNORE") recommendedAction = "NO_ACTION";

  const reasons = [...base.reasons];
  if (DECISION_RANK[decision] < DECISION_RANK[base.decision] || ACTION_PERMISSIVENESS[recommendedAction] < ACTION_PERMISSIVENESS[base.recommendedAction]) {
    reasons.push(`The language model judged this more conservatively than the rules (${decision}, ${recommendedAction}); the stricter view is kept.`);
  }

  return {
    ...base,
    decision,
    recommendedAction,
    confidence,
    summary: p.summary.trim(),
    reasons,
    executableUnderRules: decision === "EXECUTABLE",
    source: "deterministic+llm_summary",
    guardrails: { clamped, llm: "verified", model: result.model },
  };
}
