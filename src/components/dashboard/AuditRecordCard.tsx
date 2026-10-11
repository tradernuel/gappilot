"use client";

import type { AuditRecord } from "@/lib/execution/types";

const RESULT_STYLE: Record<AuditRecord["result"], { label: string; tone: string }> = {
  SIMULATED_FILL: { label: "Simulated fill", tone: "text-watch" },
  FILLED: { label: "Filled", tone: "text-exec" },
  FILLED_BELOW_MINIMUM: { label: "Filled below minimum", tone: "text-danger" },
  FAILED: { label: "Failed", tone: "text-danger" },
  REFUSED: { label: "Refused", tone: "text-act" },
  PENDING: { label: "Pending", tone: "text-act" },
};

/** Unmistakable mode marker. SIMULATED is hatched; LIVE is solid red. */
export function ModeBadge({ mode }: { mode: AuditRecord["mode"] }) {
  return mode === "LIVE" ? (
    <span className="inline-flex items-center rounded-[3px] bg-danger px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-ink">LIVE</span>
  ) : (
    <span
      className="inline-flex items-center rounded-[3px] border border-watch/60 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-watch"
      style={{ backgroundImage: "repeating-linear-gradient(135deg, rgba(142,159,207,.16) 0 4px, transparent 4px 8px)" }}
      title="Simulated execution: no transaction was created or sent"
    >
      SIMULATED
    </span>
  );
}

const short = (h: string) => (h.length > 22 ? `${h.slice(0, 12)}…${h.slice(-6)}` : h);

function TxHash({ r }: { r: AuditRecord }) {
  const h = r.execution.txHash;
  if (!h) return <span className="text-faint">none</span>;
  if (r.mode === "LIVE" && /^0x[0-9a-fA-F]{64}$/.test(h)) {
    return <a className="num underline decoration-rule-strong underline-offset-2" href={`https://bscscan.com/tx/${h}`} target="_blank" rel="noreferrer">{short(h)}</a>;
  }
  return <span className="num text-watch" title={`${h}: simulated, not a blockchain transaction`}>{h.startsWith("SIMULATED-") ? `SIM-${h.slice(10, 18)}` : short(h)}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11.5px] text-dim">{label}</dt>
      <dd className="mt-0.5 break-words text-[12.5px] sm:truncate">{children}</dd>
    </div>
  );
}

export function AuditRecordCard({ record: r, compact = false }: { record: AuditRecord; compact?: boolean }) {
  const res = RESULT_STYLE[r.result];
  return (
    <article className={`border bg-ink ${r.mode === "LIVE" ? "border-danger/40" : "border-rule"}`}>
      <header className="flex flex-wrap items-center gap-2 border-b border-rule/70 px-3.5 py-2">
        <ModeBadge mode={r.mode} />
        <span className="font-medium">{r.asset?.symbol ?? "—"}</span>
        <span className={`text-[12.5px] font-medium ${res.tone}`}>{res.label}</span>
        <span className="num ml-auto text-[11.5px] text-dim">{new Date(r.timestamp).toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })}</span>
      </header>
      {r.mode === "SIMULATED" && r.result !== "REFUSED" && (
        <p className="border-b border-rule/70 px-3.5 py-1.5 text-[12px] text-watch">Simulated execution. No transaction was created or sent.</p>
      )}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-3.5 py-2.5 sm:grid-cols-3">
        <Field label="Strategy">{r.strategy?.name ?? "None (manual)"}</Field>
        <Field label="Signal">{r.signal ? `${r.signal.direction.toLowerCase()} ${r.signal.spreadPercent.toFixed(2)}%, agent ${r.signal.agentDecision.toLowerCase()}` : "—"}</Field>
        <Field label="Authorization">
          {r.authorization.state === "USER_APPROVED" ? "You approved" : r.authorization.state === "AUTONOMOUS_GRANT" ? "Autonomous grant" : "None"}
          {", "}
          <span className={r.authorization.verdict === "AUTHORIZED" ? "text-exec" : "text-act"}>{r.authorization.verdict.toLowerCase()}</span>
        </Field>
        <Field label="Quote">{r.quote ? `${r.quote.input ?? "—"} → ${r.quote.expectedOutput ?? "—"}` : "—"}</Field>
        <Field label="Simulation">{r.simulation ? `${r.simulation.status.toLowerCase()}${r.simulation.transactions.length ? ` (${r.simulation.transactions.map((t) => `${t.kind.toLowerCase()} ${t.status.toLowerCase()}`).join(", ")})` : ""}` : "—"}</Field>
        <Field label="Transaction"><TxHash r={r} /></Field>
      </dl>
      {r.authorization.violations.length > 0 && (
        <ul className="space-y-0.5 border-t border-rule/70 px-3.5 py-2 text-[12px] text-act">
          {r.authorization.violations.map((v, i) => <li key={i}><span className="num text-faint">{v.code}</span> {v.message}</li>)}
        </ul>
      )}
      {!compact && (
        <details className="border-t border-rule/70 px-3.5 py-1.5 text-[11.5px] text-faint">
          <summary className="cursor-pointer">Full record ({r.provider}, hash {r.hash.slice(0, 10)}…)</summary>
          <pre className="num mt-1.5 max-h-60 overflow-auto whitespace-pre-wrap break-all">{JSON.stringify(r, null, 2)}</pre>
        </details>
      )}
    </article>
  );
}
