"use client";

import { useEffect, useRef, useState } from "react";
import type { Opportunity } from "@/lib/engine/types";
import type { UserRules } from "@/lib/agent/types";
import type { Strategy } from "@/lib/strategy/schema";
import type { PreviewStatus, StepName, TradePreview } from "@/lib/trade/types";
import { approveTrade, simulateTrade } from "@/lib/client/api";
import { fmtUsd, shortAddress } from "@/lib/client/format";
import { Button } from "./states";
import { AuditRecordCard } from "./AuditRecordCard";
import { useAudit } from "@/lib/client/use-audit";
import type { AuditRecord } from "@/lib/execution/types";

type Phase =
  | { kind: "simulating" }
  | { kind: "error"; message: string }
  | { kind: "preview"; preview: TradePreview }
  | { kind: "approving"; preview: TradePreview }
  | { kind: "approved"; preview: TradePreview; record: AuditRecord };

const STEP_LABEL: Record<StepName, string> = {
  STRATEGY: "Strategy",
  BALANCE: "Balance",
  QUOTE: "Quote",
  EXPECTED_OUTPUT: "Expected output",
  BUILD: "Build",
  SIMULATION: "Simulation",
};
const STEP_ORDER: StepName[] = ["STRATEGY", "BALANCE", "QUOTE", "EXPECTED_OUTPUT", "BUILD", "SIMULATION"];

const STATUS_STYLE: Record<PreviewStatus, { title: string; tone: string; border: string }> = {
  PASSED: { title: "SIMULATION PASSED", tone: "text-exec", border: "border-exec/50 bg-exec/[0.06]" },
  FAILED: { title: "SIMULATION FAILED", tone: "text-danger", border: "border-danger/50 bg-danger/[0.06]" },
  BLOCKED: { title: "NOT SIMULATED", tone: "text-act", border: "border-act/50 bg-act/[0.05]" },
  APPROVAL_REQUIRED: { title: "APPROVAL NEEDED FIRST", tone: "text-act", border: "border-act/50 bg-act/[0.05]" },
  UNVERIFIABLE: { title: "CAN'T BE SIMULATED", tone: "text-act", border: "border-act/50 bg-act/[0.05]" },
};

const amt = (n: number, symbol: string) => `${n.toLocaleString("en-US", { maximumFractionDigits: n < 1 ? 8 : 6 })} ${symbol}`;

export function TradePreviewDialog(props: {
  open: boolean;
  onClose: () => void;
  opportunity: Opportunity;
  attestation: string;
  wallet: string;
  rules: UserRules;
  strategy: Strategy | null;
  strategyName?: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const audit = useAudit();
  const [phase, setPhase] = useState<Phase>({ kind: "simulating" });
  const [confirmed, setConfirmed] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const run = async () => {
    setConfirmed(false);
    setPhase({ kind: "simulating" });
    const r = await simulateTrade({ opportunity: props.opportunity, attestation: props.attestation, wallet: props.wallet, rules: props.rules, strategy: props.strategy, strategyName: props.strategyName });
    setPhase(r.ok ? { kind: "preview", preview: r.data } : { kind: "error", message: r.error.message });
  };

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) {
      d.showModal();
      run();
    }
    if (!props.open && d.open) d.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  useEffect(() => {
    if (phase.kind !== "preview") return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [phase.kind]);

  const approve = async (preview: TradePreview) => {
    if (!preview.planToken) return;
    setPhase({ kind: "approving", preview });
    const r = await approveTrade({ planToken: preview.planToken, wallet: props.wallet, preview, opportunity: props.opportunity, attestation: props.attestation });
    if (r.ok) audit?.add([r.data]);
    setPhase(r.ok ? { kind: "approved", preview, record: r.data } : { kind: "error", message: r.error.message });
  };

  const preview = "preview" in phase ? phase.preview : null;

  return (
    <dialog
      ref={ref}
      onClose={props.onClose}
      aria-labelledby="trade-title"
      className="m-0 h-dvh max-h-dvh w-full max-w-full bg-panel p-0 text-text backdrop:bg-ink/75 sm:m-auto sm:h-auto sm:max-h-[92dvh] sm:w-[min(94vw,760px)] sm:rounded-[4px] sm:border sm:border-rule-strong"
    >
      <div className="flex max-h-[inherit] flex-col sm:max-h-[92dvh]">
        <div className="flex items-start gap-3 border-b border-rule px-5 py-3.5">
          <div className="min-w-0 flex-1">
            <h2 id="trade-title" className="font-semibold tracking-tight">Trade preview</h2>
            <p className="text-[12px] text-dim">
              {props.opportunity.spotAction === "SELL_TOKEN" ? "Sell" : "Buy"} {props.opportunity.asset.symbol} from <span className="num">{shortAddress(props.wallet)}</span>
              {props.strategy ? ", checked against your saved strategy" : ", checked against your agent rules"}. Nothing is sent without your confirmation.
            </p>
          </div>
          <button onClick={props.onClose} aria-label="Close trade preview" className="-mr-1 rounded-[3px] p-1.5 text-dim hover:bg-raised hover:text-text">
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" /></svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <Pipeline preview={preview} simulating={phase.kind === "simulating"} />

          {phase.kind === "simulating" && (
            <div role="status" className="space-y-2.5 px-5 py-6">
              <p className="text-[13px] text-dim">Getting a fresh quote, building the transaction and simulating it…</p>
              <div className="skeleton h-16 w-full" />
              <div className="skeleton h-40 w-full" />
            </div>
          )}

          {phase.kind === "error" && (
            <div role="alert" className="m-5 border-l-2 border-danger/60 bg-ink px-4 py-3">
              <p className="font-medium text-danger">The simulation request failed</p>
              <p className="mt-1 text-[13px] text-dim">{phase.message} Nothing was executed.</p>
              <Button className="mt-3" onClick={run}>Simulate again</Button>
            </div>
          )}

          {preview && <PreviewBody preview={preview} />}
        </div>

        {preview && (
          <ApprovalFooter
            phase={phase}
            preview={preview}
            now={now}
            confirmed={confirmed}
            setConfirmed={setConfirmed}
            onApprove={() => approve(preview)}
            onResimulate={run}
            onClose={props.onClose}
          />
        )}
      </div>
    </dialog>
  );
}

function Pipeline({ preview, simulating }: { preview: TradePreview | null; simulating: boolean }) {
  const byStep = new Map(preview?.steps.map((s) => [s.step, s]) ?? []);
  return (
    <ol aria-label="Simulation steps" className="flex flex-wrap gap-x-1 gap-y-1.5 border-b border-rule px-5 py-3 text-[12px]">
      {STEP_ORDER.map((step, i) => {
        const s = byStep.get(step);
        const tone = s?.status === "ok" ? "text-exec" : s?.status === "failed" ? "text-danger" : s?.status === "skipped" ? "text-act" : "text-faint";
        const mark = s?.status === "ok" ? "✓" : s?.status === "failed" ? "✕" : s?.status === "skipped" ? "–" : simulating ? "·" : "·";
        return (
          <li key={step} className="flex items-center gap-1" title={s?.detail}>
            <span className={`num ${tone}`} aria-hidden>{mark}</span>
            <span className={s ? "text-text" : "text-faint"}>{i + 1}. {STEP_LABEL[step]}</span>
            <span className="sr-only">{s ? `: ${s.status}. ${s.detail}` : ": not reached"}</span>
            {i < STEP_ORDER.length - 1 && <span aria-hidden className="mx-1 text-faint">→</span>}
          </li>
        );
      })}
    </ol>
  );
}

function Row({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,140px)_1fr] gap-3 px-5 py-2 text-[13.5px] sm:grid-cols-[170px_1fr]">
      <dt className="text-dim">{label}</dt>
      <dd className="min-w-0">
        {children}
        {note && <span className="mt-0.5 block text-[12px] text-dim">{note}</span>}
      </dd>
    </div>
  );
}

function PreviewBody({ preview: p }: { preview: TradePreview }) {
  const s = STATUS_STYLE[p.status];
  const gasText = p.gas.totalUsd !== null ? fmtUsd(p.gas.totalUsd, p.gas.totalUsd < 1 ? 4 : 2) : p.gas.totalBnb !== null ? `${p.gas.totalBnb.toFixed(6)} BNB` : "—";
  return (
    <>
      <section aria-live="polite" className={`mx-5 mt-4 border ${s.border} px-4 py-3.5`}>
        <p className={`text-[13px] font-semibold tracking-wide ${s.tone}`}>{s.title}</p>
        {p.status === "PASSED" ? (
          <dl className="mt-2.5 grid grid-cols-3 gap-3">
            <div>
              <dt className="text-[12px] text-dim">Expected output</dt>
              <dd className="num mt-0.5 text-[20px] leading-tight">{fmtUsd(p.expectedOutput?.usd ?? null)}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-dim">Estimated gas</dt>
              <dd className="num mt-0.5 text-[20px] leading-tight">{gasText}</dd>
            </div>
            <div>
              <dt className="text-[12px] text-dim">Estimated slippage</dt>
              <dd className="num mt-0.5 text-[20px] leading-tight">{p.estimatedSlippagePercent !== null ? `${p.estimatedSlippagePercent.toFixed(2)}%` : "—"}</dd>
            </div>
          </dl>
        ) : (
          <>
            <p className="mt-1.5 text-[14px]">{p.failureReason ?? p.headline}</p>
            <p className="mt-1 text-[12px] text-dim">Nothing will be executed.</p>
          </>
        )}
      </section>

      {p.input && (
        <section aria-labelledby="trade-details" className="mt-4">
          <h3 id="trade-details" className="px-5 text-[12px] text-dim">Proposed trade</h3>
          <dl className="mt-1 divide-y divide-rule/70 border-y border-rule/70">
            <Row label="Input asset">{p.input.symbol} <span className="num text-[12px] text-faint">{shortAddress(p.input.address)}</span></Row>
            <Row label="Output asset">{p.expectedOutput?.symbol} <span className="num text-[12px] text-faint">{p.expectedOutput && shortAddress(p.expectedOutput.address)}</span></Row>
            <Row label="Input amount" note={p.input.usd !== null ? `≈ ${fmtUsd(p.input.usd)}` : undefined}><span className="num">{amt(p.input.amount, p.input.symbol)}</span></Row>
            {p.expectedOutput && <Row label="Expected output" note={p.expectedOutput.usd !== null ? `≈ ${fmtUsd(p.expectedOutput.usd)} at the on-chain price` : undefined}><span className="num">{amt(p.expectedOutput.amount, p.expectedOutput.symbol)}</span></Row>}
            <Row
              label="Minimum output"
              note={p.minimumOutput ? { TRANSACTION: "From the transaction (your slippage limit)", TYPED_DATA: "From the signed order", COMPUTED_FROM_SLIPPAGE: "Computed from your slippage limit" }[p.minimumOutput.source] : "Not available until the transaction is built"}
            >
              <span className="num">{p.minimumOutput ? amt(p.minimumOutput.amount, p.minimumOutput.symbol) : "—"}</span>
            </Row>
            <Row label="Price impact / slippage" note={`Your limit: ${p.slippageLimitPercent.toFixed(2)}%`}>
              <span className="num">{p.priceImpactPercent !== null ? `${p.priceImpactPercent.toFixed(2)}% impact` : "impact n/a"}, {p.estimatedSlippagePercent !== null ? `${p.estimatedSlippagePercent.toFixed(2)}% vs on-chain mid` : "slippage n/a"}</span>
            </Row>
            <Row label="Gas estimate" note={p.gas.note}><span className="num">{gasText}{p.gas.totalUsd !== null && p.gas.totalBnb !== null ? ` (${p.gas.totalBnb.toFixed(6)} BNB)` : ""}</span></Row>
            <Row label="Route" note={p.route.hops.length ? p.route.hops.map((h) => `${h.dex}${h.percent ? ` ${h.percent}%` : ""}`).join(", ") : undefined}>
              {p.route.vendor ?? "—"} <span className="text-dim">({p.route.executionMode ?? "mode unknown"})</span>
            </Row>
            <Row label="Estimated net result" note="Output valued at the reference price, minus input and gas. An estimate, not a guaranteed result.">
              <span className={`num ${p.net.vsReferenceUsd !== null && p.net.vsReferenceUsd > 0 ? "text-text" : "text-dim"}`}>
                {p.net.vsReferenceUsd !== null ? `${p.net.vsReferenceUsd >= 0 ? "+" : "−"}${fmtUsd(Math.abs(p.net.vsReferenceUsd))}` : "—"}
                {p.net.vsReferencePercent !== null ? ` (${p.net.vsReferencePercent >= 0 ? "+" : "−"}${Math.abs(p.net.vsReferencePercent).toFixed(2)}%)` : ""}
              </span>
            </Row>
          </dl>
        </section>
      )}

      {(p.transactions.length > 0 || p.rfqOrder) && (
        <section aria-labelledby="tx-heading" className="mt-4 px-5">
          <h3 id="tx-heading" className="text-[12px] text-dim">What your wallet would sign</h3>
          <ul className="mt-1.5 space-y-2">
            {p.transactions.map((t, i) => (
              <li key={i} className="border border-rule bg-ink px-3.5 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{t.kind === "APPROVE" ? "Approval" : "Swap"}</span>
                  <span className="text-dim">{t.description}</span>
                  <span className={`ml-auto text-[12px] ${t.simulation?.passed ? "text-exec" : t.simulation ? "text-danger" : "text-act"}`}>
                    {t.simulation ? (t.simulation.passed ? "✓ Simulated" : `✕ ${t.simulation.status}`) : "Not simulated"}
                  </span>
                </div>
                <p className="num mt-1 text-[12px] text-faint">to {shortAddress(t.to)}, value {t.value} wei{t.gasLimit ? `, gas limit ${t.gasLimit}` : ""}</p>
                <ul className="mt-1.5 space-y-0.5 text-[12.5px]">
                  {t.checks.map((c, j) => (
                    <li key={j} className={c.passed ? "text-dim" : "text-danger"}><span aria-hidden>{c.passed ? "✓" : "✕"}</span> {c.detail}</li>
                  ))}
                </ul>
                <details className="mt-1.5 text-[12px] text-faint">
                  <summary className="cursor-pointer">Transaction data (built by Binance)</summary>
                  <p className="num mt-1 break-all">{t.data}</p>
                </details>
              </li>
            ))}
            {p.rfqOrder && (
              <li className="border border-rule bg-ink px-3.5 py-2.5 text-[13px]">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">Signed order (RFQ)</span>
                  <span className="text-dim">{p.rfqOrder.domainName ?? "Vendor"} {p.rfqOrder.primaryType ?? ""}</span>
                  <span className="ml-auto text-[12px] text-dim">Checked, not simulated</span>
                </div>
                <ul className="mt-1.5 space-y-0.5 text-[12.5px]">
                  {p.rfqOrder.checks.map((c, j) => (
                    <li key={j} className={c.passed ? "text-dim" : "text-danger"}><span aria-hidden>{c.passed ? "✓" : "✕"}</span> {c.detail}</li>
                  ))}
                </ul>
              </li>
            )}
          </ul>
        </section>
      )}

      {p.warnings.length > 0 && (
        <ul className="mx-5 mt-3 space-y-1 text-[12px] text-act">
          {p.warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}
      <p className="mx-5 mb-4 mt-3 text-[12px] leading-relaxed text-faint">{p.disclaimer}</p>
    </>
  );
}

function ApprovalFooter(props: {
  phase: Phase;
  preview: TradePreview;
  now: number;
  confirmed: boolean;
  setConfirmed: (v: boolean) => void;
  onApprove: () => void;
  onResimulate: () => void;
  onClose: () => void;
}) {
  const { phase, preview: p } = props;
  const left = Math.max(0, Math.ceil((p.expiresAt - props.now) / 1000));
  const expired = left === 0;

  if (phase.kind === "approved") {
    const r = phase.record;
    return (
      <div role="status" className="max-h-[55dvh] overflow-y-auto border-t border-rule px-5 py-3.5">
        <p className={`font-medium ${r.result === "REFUSED" ? "text-act" : r.mode === "LIVE" ? "text-exec" : "text-watch"}`}>
          {r.result === "REFUSED" ? "Approved, but the execution policy refused it." : r.mode === "LIVE" ? "Executed." : "Approved and executed in simulation."}
        </p>
        <div className="mt-2.5"><AuditRecordCard record={r} compact /></div>
        <div className="mt-3 flex justify-end"><Button onClick={props.onClose}>Close</Button></div>
      </div>
    );
  }

  if (p.status !== "PASSED") {
    return (
      <div className="flex flex-wrap items-center gap-3 border-t border-rule px-5 py-3">
        <span className="text-[12.5px] text-dim">Confirmation is only possible after a passed simulation.</span>
        <span className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={props.onClose}>Close</Button>
          <Button onClick={props.onResimulate}>Simulate again</Button>
        </span>
      </div>
    );
  }

  return (
    <div className="border-t border-rule px-5 py-3.5">
      {expired ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-[13px] text-act">The quote expired. Simulate again to get a fresh quote before confirming.</p>
          <Button className="ml-auto" onClick={props.onResimulate}>Simulate again</Button>
        </div>
      ) : (
        <>
          <label className="flex items-start gap-2.5 text-[13px]">
            <input type="checkbox" className="mt-0.5 accent-[#3fd1a9]" checked={props.confirmed} onChange={(e) => props.setConfirmed(e.target.checked)} />
            <span>I&apos;ve reviewed this trade and its simulation, and I understand the result is an estimate.</span>
          </label>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="num text-[12px] text-dim" aria-live="off">Quote valid for {left}s</span>
            <span className="ml-auto flex gap-2">
              <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
              <Button variant="primary" onClick={props.onApprove} disabled={!props.confirmed || phase.kind === "approving"}>
                {phase.kind === "approving" ? "Confirming…" : "Confirm trade"}
              </Button>
            </span>
          </div>
          <p className="mt-2 text-[12px] text-faint">This web app executes in <span className="text-watch">simulation</span>: confirming runs the policy checks and a simulated fill. No transaction is created or sent.</p>
        </>
      )}
    </div>
  );
}
