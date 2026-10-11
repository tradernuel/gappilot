"use client";

import { useEffect, useState } from "react";
import { formatCountdown, type WeekendState } from "@/lib/client/weekend";
import { fmtClock, fmtPct } from "@/lib/client/format";

/**
 * The Weekend Mode band. Every figure comes from the latest scan
 * (deriveWeekendState); nothing here is hardcoded.
 */
export function WeekendPanel({ state, loading, updatedAt, refreshSec }: { state: WeekendState; loading: boolean; updatedAt: number | null; refreshSec: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const active = state.status === "ACTIVE";
  const standby = state.status === "STANDBY";
  const countdown = formatCountdown(state.nextOpenTime, now);
  const pending = loading && state.status === "UNKNOWN";

  const tone = active ? "border-act/50" : standby ? "border-exec/40" : "border-rule";
  const tint = active ? "bg-[linear-gradient(90deg,rgba(240,167,58,.09),rgba(240,167,58,.02)_55%,transparent)]" : "";

  return (
    <section aria-label="Weekend mode" className={`border-b border-t-2 ${tone} ${tint}`}>
      <div className="grid gap-px md:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)] lg:grid-cols-[minmax(170px,0.8fr)_minmax(250px,1.3fr)_minmax(0,2fr)]">
        {/* Mode */}
        <div className="px-4 py-4 lg:px-6">
          <p className="text-[11.5px] font-semibold tracking-[0.12em] text-dim">WEEKEND MODE</p>
          <p className="mt-1.5 flex items-center gap-2 text-[15px] font-semibold tracking-wide" aria-live="polite">
            <span aria-hidden className="relative flex h-2.5 w-2.5">
              {active && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-act opacity-60 motion-reduce:animate-none" />}
              <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${active ? "bg-act" : standby ? "border border-exec" : "border border-faint"}`} />
            </span>
            <span className={active ? "text-act" : standby ? "text-exec" : "text-dim"}>{pending ? "STARTING" : state.status}</span>
          </p>
          <p className="mt-1.5 text-[12px] text-dim">
            {active ? `Scanning every ${refreshSec} s` : standby ? "Waiting for the market to close" : "Waiting for market status"}
            {/* Phones don't show the header's update time, so show it here below lg. */}
            {updatedAt && <span className="text-faint lg:hidden">, updated <span className="num">{fmtClock(updatedAt)}</span></span>}
          </p>
        </div>

        {/* Market */}
        <div className="px-4 py-4 md:border-l md:border-rule/70 lg:px-6">
          <p className="text-[11.5px] font-semibold tracking-[0.12em] text-dim">US EQUITY MARKET</p>
          <p className={`mt-1 text-[28px] font-semibold leading-none tracking-tight ${active ? "text-act" : standby ? "text-exec" : "text-faint"}`}>
            {pending ? "…" : state.marketLabel === "UNKNOWN" ? "UNKNOWN" : state.marketLabel}
          </p>
          <div className="mt-2 text-[13px] leading-snug">
            {active ? (
              <>
                <p className="font-medium">Reference prices may be stale.</p>
                <p className="mt-0.5 text-dim">
                  {state.reason ? `${state.reason}. ` : ""}Tokens keep trading on-chain; GapPilot compares issuers instead of the frozen official price.
                </p>
                {countdown && <p className="num mt-1 text-[12.5px] text-act">Opens in {countdown}</p>}
              </>
            ) : standby ? (
              <p className="text-dim">Official prices are live, so tokenized prices should track them closely.</p>
            ) : (
              <p className="text-dim">{pending ? "Reading market status from Binance…" : "The API didn't report market status for this scan."}</p>
            )}
          </div>
        </div>

        {/* Numbers */}
        <dl className="grid grid-cols-3 border-t border-rule/70 md:col-span-2 lg:col-span-1 lg:border-l lg:border-t-0">
          {[
            { label: "Monitoring", value: state.monitoring, sub: state.monitoring !== null ? `tokenized equities, ${state.compared} compared` : "tokenized equities", tone: "" },
            { label: "Opportunities", value: state.opportunities, sub: state.avgAbsSpread !== null && state.opportunities ? `avg spread ${fmtPct(state.avgAbsSpread)}` : "above noise", tone: "" },
            { label: "Actionable", value: state.actionable, sub: state.executable ? `${state.executable} executable from your wallet` : "none executable yet", tone: state.actionable ? "text-act" : "" },
          ].map((n, i) => (
            <div key={n.label} className={`min-w-0 px-3 py-4 sm:px-4 lg:px-6 ${i ? "border-l border-rule/70" : ""}`}>
              <dt className="truncate text-[10.5px] font-semibold tracking-[0.06em] text-dim sm:text-[11.5px] sm:tracking-[0.12em]">{n.label.toUpperCase()}</dt>
              <dd className={`num mt-1 text-[34px] leading-none font-medium ${n.tone}`}>
                {pending ? <span className="skeleton inline-block h-8 w-10 align-middle" /> : n.value ?? "—"}
              </dd>
              <dd className={`mt-1.5 text-[12px] ${i === 2 && state.executable ? "text-exec" : "text-dim"}`}>{n.sub}</dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}

/** Header switch. */
export function WeekendToggle({ on, active, onChange }: { on: boolean; active: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      title={on ? "Weekend mode is on" : "Turn on weekend mode"}
      className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[3px] px-1.5 text-[12px] sm:px-2 font-semibold tracking-[0.08em] text-dim hover:bg-raised hover:text-text"
    >
      <span aria-hidden className={`relative h-4 w-7 rounded-full transition-colors ${on ? (active ? "bg-act" : "bg-exec/70") : "bg-rule-strong"}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-ink transition-[left] ${on ? "left-[14px]" : "left-0.5"}`} />
      </span>
      <span className="hidden sm:inline">WEEKEND</span>
      <span className="sr-only sm:hidden">Weekend mode</span>
    </button>
  );
}
