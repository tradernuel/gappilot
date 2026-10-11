"use client";

import { useEffect, useMemo, useState } from "react";
import type { Opportunity } from "@/lib/engine/types";
import { runAgentDeterministic } from "@/lib/agent/deterministic";
import type { AgentOutput, RecommendedAction, RuleCode, Severity, UserRules } from "@/lib/agent/types";
import { fetchAgent } from "@/lib/client/api";
import { matchStrategy } from "@/lib/strategy/match";
import type { SavedStrategy } from "@/lib/strategy/schema";
import { TradePreviewDialog } from "./TradePreviewDialog";
import { ActionBadge, ConfidenceMeter } from "./primitives";
import { Button } from "./states";

const ACTION_LABEL: Record<RecommendedAction, { label: string; tone: string; note: string }> = {
  SIMULATE: { label: "Simulate first", tone: "border-exec/50 text-exec", note: "Run a pre-trade simulation before any trade. Nothing runs automatically." },
  WAIT: { label: "Wait", tone: "border-watch/50 text-watch", note: "Conditions may change: refresh, connect a wallet, or let data update." },
  NO_ACTION: { label: "No action", tone: "border-rule-strong text-dim", note: "Nothing to do with this wallet under your rules." },
};

const SEVERITY_TONE: Record<Severity, string> = { HIGH: "text-danger", MEDIUM: "text-act", LOW: "text-dim" };

const RULE_LABEL: Record<RuleCode, string> = {
  MAX_NOTIONAL: "Trade size",
  MIN_NET_EDGE: "Net edge",
  MAX_SLIPPAGE: "Slippage",
  MAX_REFERENCE_AGE: "Reference age",
  MIN_CONFIDENCE: "Confidence",
  MARKET_CLOSED: "Market hours",
};

type Narration = { phase: "idle" } | { phase: "loading" } | { phase: "done"; out: AgentOutput } | { phase: "error"; message: string };

/**
 * The reasoning agent's view of one opportunity. The deterministic output is
 * computed instantly in the browser (same pure function the server runs). The
 * optional AI summary comes from the server and is verified there.
 */
export function AgentPanel({ opportunity, attestation, rules, wallet, strategies }: { opportunity: Opportunity; attestation: string | undefined; rules: UserRules; wallet: string | null; strategies: SavedStrategy[] }) {
  const local = useMemo(() => runAgentDeterministic(opportunity, rules), [opportunity, rules]);
  const [narration, setNarration] = useState<Narration>({ phase: "idle" });
  useEffect(() => setNarration({ phase: "idle" }), [opportunity.asset.address, opportunity.evaluatedAt, rules]);

  const out = narration.phase === "done" ? narration.out : local;
  const action = ACTION_LABEL[out.recommendedAction];

  const write = async () => {
    if (!attestation) return;
    setNarration({ phase: "loading" });
    const res = await fetchAgent(opportunity, attestation, rules, true);
    setNarration(res.ok ? { phase: "done", out: res.data } : { phase: "error", message: res.error.message });
  };

  return (
    <section aria-labelledby="agent-heading" className="border-t border-rule px-5 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 id="agent-heading" className="font-medium">Agent</h3>
        <ActionBadge action={out.decision} />
        <span className={`rounded-[3px] border px-2 py-0.5 text-[12px] font-medium ${action.tone}`} title={action.note}>
          {action.label}
        </span>
        <ConfidenceMeter level={out.confidence} />
      </div>

      <p className="mt-3 text-[14px] leading-relaxed" aria-live="polite">
        {narration.phase === "loading" ? <span className="text-dim">Writing summary…</span> : out.summary}
      </p>
      <p className="mt-1.5 text-[12px] text-dim">{action.note}</p>

      {out.decision !== out.engineAction && (
        <p className="mt-2 text-[12px] text-dim">
          Stricter than the engine ({out.engineAction.toLowerCase()} → {out.decision.toLowerCase()}). The agent can lower a classification, never raise it.
        </p>
      )}

      {out.riskDetails.length > 0 && (
        <div className="mt-3.5">
          <h4 className="text-[12px] text-dim">Risks, main risk first</h4>
          <ul className="mt-1.5 space-y-1.5 text-[13px] leading-relaxed">
            {out.riskDetails.map((r, i) => (
              <li key={r.code} className={`flex gap-2.5 ${i === 0 ? "" : "text-dim"}`}>
                <span className={`w-14 shrink-0 text-[11.5px] font-medium ${SEVERITY_TONE[r.severity]}`}>{r.severity.charAt(0) + r.severity.slice(1).toLowerCase()}</span>
                <span>{r.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3.5">
        <h4 className="text-[12px] text-dim">Your rules</h4>
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Rule checks">
          {out.ruleChecks.map((c) => (
            <li key={c.rule} title={c.detail} className={`rounded-[3px] border px-1.5 py-0.5 text-[11.5px] ${c.passed ? "border-rule-strong text-dim" : "border-act/40 text-act"}`}>
              <span aria-hidden>{c.passed ? "✓" : "✕"}</span> {RULE_LABEL[c.rule]}
              <span className="sr-only">{c.passed ? " passed" : ` failed: ${c.detail}`}</span>
            </li>
          ))}
        </ul>
      </div>

      {out.recommendedAction === "SIMULATE" && (
        <SimulateBlock opportunity={opportunity} attestation={attestation} rules={rules} wallet={wallet} strategies={strategies} />
      )}

      <details className="mt-3 text-[13px]">
        <summary className="cursor-pointer text-[12px] text-dim">Agent reasoning ({out.reasons.length})</summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 leading-relaxed text-dim">
          {out.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ol>
      </details>

      <div className="mt-3.5 flex flex-wrap items-center gap-3 border-t border-rule/70 pt-3 text-[12px] text-dim">
        <Provenance out={out} narration={narration} />
        {narration.phase !== "done" && (
          <Button onClick={write} disabled={!attestation || narration.phase === "loading"} className="ml-auto">
            Write summary with AI
          </Button>
        )}
      </div>
    </section>
  );
}

function Provenance({ out, narration }: { out: AgentOutput; narration: Narration }) {
  if (narration.phase === "error") return <span className="text-danger">{narration.message}</span>;
  const g = out.guardrails;
  if (g.llm === "verified") {
    return (
      <span>
        <span className="text-exec">✓</span> Summary by {g.model}, every figure checked against engine data.
        {g.clamped.length > 0 && <> The model proposed a less cautious {g.clamped.join(", ")}; it was overruled.</>}
      </span>
    );
  }
  if (g.llm === "rejected") return <span>The AI summary was discarded ({g.llmDetail}). Showing the rule-based summary.</span>;
  if (g.llm === "not_configured") return <span>AI summaries aren&apos;t configured on this server. The rule-based summary is complete.</span>;
  if (g.llm === "error") return <span>The AI summary failed. Showing the rule-based summary.</span>;
  return <span>Decided by GapPilot&apos;s rules. No AI involved.</span>;
}

function SimulateBlock({ opportunity, attestation, rules, wallet, strategies }: { opportunity: Opportunity; attestation: string | undefined; rules: UserRules; wallet: string | null; strategies: SavedStrategy[] }) {
  const matching = useMemo(() => strategies.filter((s) => matchStrategy(s.strategy, opportunity).matches), [strategies, opportunity]);
  const [strategyId, setStrategyId] = useState<string>("");
  const [open, setOpen] = useState(false);
  const selectedEntry = matching.find((s) => s.id === strategyId) ?? null;
  const selected = selectedEntry?.strategy ?? null;
  const disabledReason = !wallet ? "Connect a wallet on BNB Smart Chain to simulate." : !attestation ? "Rescan to simulate." : null;

  return (
    <div className="mt-3.5 border border-exec/30 bg-exec/[0.04] px-3.5 py-3">
      <p className="text-[13px]">Next step: simulate the trade. GapPilot gets a fresh quote, has Binance build the transaction, and runs the Transaction API simulation. Nothing is sent.</p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
        {matching.length > 0 && (
          <label className="flex items-center gap-2 text-[12.5px] text-dim">
            Check against
            <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className="h-8 max-w-[220px] rounded-[3px] border border-rule-strong bg-ink px-2 text-text">
              <option value="">Agent rules only</option>
              {matching.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}
        <Button variant="primary" onClick={() => setOpen(true)} disabled={!!disabledReason} className="ml-auto">Simulate trade</Button>
      </div>
      {disabledReason && <p className="mt-1.5 text-[12px] text-dim">{disabledReason}</p>}
      {open && wallet && attestation && (
        <TradePreviewDialog open={open} onClose={() => setOpen(false)} opportunity={opportunity} attestation={attestation} wallet={wallet} rules={rules} strategy={selected} strategyName={selectedEntry?.name ?? null} />
      )}
    </div>
  );
}
