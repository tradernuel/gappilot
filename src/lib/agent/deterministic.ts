/**
 * Deterministic agent: pure and synchronous, safe to run in the browser.
 * The server runs the same function and treats its output as authoritative.
 */
import { DISCLAIMER, type Opportunity } from "../engine/types";
import { checkRules, decide, explain, identifyRisks, mainRisk, summarize } from "./policy";
import { DEFAULT_USER_RULES, type AgentOutput, type UserRules } from "./types";

/** Deterministic part only. Synchronous and pure. */
export function runAgentDeterministic(o: Opportunity, rules: UserRules = DEFAULT_USER_RULES): AgentOutput {
  const ruleChecks = checkRules(o, rules);
  const riskDetails = identifyRisks(o, rules);
  const top = mainRisk(riskDetails);
  const d = decide(o, ruleChecks, riskDetails);
  const reasons = explain(o, d, ruleChecks);
  // Main risk first, then the rest by severity (stable within a severity).
  const sev = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
  const ordered = top ? [top, ...riskDetails.filter((r) => r !== top).sort((a, b) => sev[a.severity] - sev[b.severity])] : [];

  return {
    decision: d.decision,
    confidence: d.confidence,
    summary: summarize(o, d, top, ruleChecks),
    reasons,
    risks: ordered.map((r) => r.text),
    recommendedAction: d.recommendedAction,
    mainRisk: top,
    riskDetails: ordered,
    executableUnderRules: d.executableUnderRules,
    ruleChecks,
    rules,
    engineAction: o.action,
    engineConfidence: o.confidence,
    asset: { address: o.asset.address, symbol: o.asset.symbol, underlyingTicker: o.asset.underlyingTicker, issuer: o.asset.issuer },
    evaluatedAt: o.evaluatedAt,
    source: "deterministic",
    guardrails: { clamped: [], llm: "not_requested" },
    disclaimer: DISCLAIMER,
  };
}

