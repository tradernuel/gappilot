"use client";

import { useEffect, useMemo, useState } from "react";
import type { UserRules } from "@/lib/agent/types";
import type { AutonomyGrant } from "@/lib/execution/types";
import type { SavedStrategy } from "@/lib/strategy/schema";
import { createAutonomyGrant, runAutonomyCycle } from "@/lib/client/api";
import { useAudit } from "@/lib/client/use-audit";
import { AuditRecordCard, ModeBadge } from "./AuditRecordCard";
import { Button } from "./states";

const GRANT_KEY = "gappilot:grant:v1";
type StoredGrant = { grant: AutonomyGrant; grantToken: string; strategyId: string };

function NumberInput({ label, value, onChange, min, max, step, note }: { label: string; value: number; onChange: (n: number) => void; min: number; max: number; step: number; note?: string }) {
  return (
    <label className="block min-w-0">
      <span className="text-[12.5px] text-dim">{label}</span>
      <input type="number" value={value} min={min} max={max} step={step} onChange={(e) => onChange(Number(e.target.value))} className="num mt-1 block h-9 w-full rounded-[3px] border border-rule-strong bg-ink px-2.5 text-text" />
      {note && <span className="mt-0.5 block text-[11.5px] text-faint">{note}</span>}
    </label>
  );
}

export function AutonomyView({ strategies, rules, wallet }: { strategies: SavedStrategy[]; rules: UserRules; wallet: string | null }) {
  const audit = useAudit();
  const [strategyId, setStrategyId] = useState("");
  const selected = strategies.find((s) => s.id === strategyId) ?? null;
  const [maxTrade, setMaxTrade] = useState(25);
  const [perDay, setPerDay] = useState(3);
  const [dailyCap, setDailyCap] = useState(75);
  const [hours, setHours] = useState(24);
  const [consent, setConsent] = useState(false);
  const [stored, setStored] = useState<StoredGrant | null>(null);
  const [busy, setBusy] = useState<"grant" | "run" | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "warn" | "error"; text: string } | null>(null);

  useEffect(() => {
    try {
      const g = JSON.parse(localStorage.getItem(GRANT_KEY) ?? "null") as StoredGrant | null;
      if (g && g.grant.expiresAt > Date.now()) setStored(g);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (selected) setMaxTrade((m) => Math.min(m, selected.strategy.maximumTradeUsd));
  }, [selected]);

  const grantStrategy = useMemo(() => strategies.find((s) => s.id === stored?.strategyId) ?? null, [strategies, stored]);
  const active = stored && stored.grant.expiresAt > Date.now() && grantStrategy ? stored : null;

  const authorize = async () => {
    if (!selected) return;
    setBusy("grant");
    setMessage(null);
    const r = await createAutonomyGrant({ strategy: selected.strategy, strategyName: selected.name, maxTradeUsd: maxTrade, maxTradesPerDay: perDay, maxDailyUsd: dailyCap, durationHours: hours });
    setBusy(null);
    if (!r.ok) return setMessage({ tone: "error", text: r.error.message });
    const g = { ...r.data, strategyId: selected.id };
    setStored(g);
    try {
      localStorage.setItem(GRANT_KEY, JSON.stringify(g));
    } catch {
      /* ignore */
    }
    setConsent(false);
    setMessage({ tone: "ok", text: "Autonomous execution authorized (simulated)." });
  };

  const revoke = () => {
    setStored(null);
    try {
      localStorage.removeItem(GRANT_KEY);
    } catch {
      /* ignore */
    }
    setMessage({ tone: "warn", text: "Grant revoked in this browser." });
  };

  const runOnce = async () => {
    if (!active || !grantStrategy || !wallet) return;
    setBusy("run");
    setMessage(null);
    const r = await runAutonomyCycle({ grantToken: active.grantToken, strategy: grantStrategy.strategy, rules, wallet });
    setBusy(null);
    if (!r.ok) return setMessage({ tone: "error", text: r.error.message });
    audit?.add(r.data.records);
    setMessage({ tone: r.data.records.some((x) => x.result === "REFUSED") ? "warn" : "ok", text: `Scanned ${r.data.scanned}, ${r.data.candidates.length} candidate${r.data.candidates.length === 1 ? "" : "s"}. ${r.data.note}` });
  };

  const exportBundle = () => {
    if (!grantStrategy) return;
    const blob = new Blob([JSON.stringify({ v: 1, strategy: grantStrategy.strategy, strategyName: grantStrategy.name, rules }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "gappilot-export.json";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const records = audit?.records ?? [];

  return (
    <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
      <div role="note" className="flex flex-wrap items-center gap-3 border-b border-watch/30 bg-watch/[0.07] px-4 py-2.5 text-[13px] lg:px-6">
        <ModeBadge mode="SIMULATED" />
        <span>This web app executes in simulation only. Every fill here comes from the mock provider; no transaction is created or sent.</span>
      </div>

      <div className="grid gap-px bg-rule lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <section aria-labelledby="grant-title" className="min-w-0 space-y-5 bg-ink px-4 py-5 lg:overflow-y-auto lg:px-6">
          <div>
            <h2 id="grant-title" className="text-[17px] font-semibold tracking-tight">Authorize the agent</h2>
            <p className="mt-1 max-w-[62ch] text-[13px] text-dim">
              Let the agent act on one saved strategy, inside limits you set. It can only trade when the scan, your strategy, the agent, the quote and the Transaction API simulation all pass, and it can never raise these limits.
            </p>
          </div>

          {active && grantStrategy ? (
            <div className="border border-exec/40 bg-exec/[0.04] px-4 py-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">Active grant</p>
                <ModeBadge mode="SIMULATED" />
                <span className="num ml-auto text-[12px] text-dim">expires {new Date(active.grant.expiresAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
              </div>
              <p className="mt-1 text-[13px]">{grantStrategy.name}</p>
              <dl className="mt-2.5 grid grid-cols-3 gap-3 text-[12.5px]">
                <div><dt className="text-dim">Per trade</dt><dd className="num">${active.grant.maxTradeUsd}</dd></div>
                <div><dt className="text-dim">Trades / day</dt><dd className="num">{active.grant.maxTradesPerDay}</dd></div>
                <div><dt className="text-dim">Daily cap</dt><dd className="num">${active.grant.maxDailyUsd}</dd></div>
              </dl>
              <div className="mt-3.5 flex flex-wrap gap-2">
                <Button variant="primary" onClick={runOnce} disabled={!wallet || busy !== null}>{busy === "run" ? "Running…" : "Run one cycle"}</Button>
                <Button onClick={exportBundle}>Export for local agent</Button>
                <Button variant="ghost" onClick={revoke} className="ml-auto">Revoke</Button>
              </div>
              {!wallet && <p className="mt-2 text-[12px] text-dim">Connect a wallet on BNB Smart Chain: the simulated run checks that wallet&apos;s balances.</p>}
            </div>
          ) : strategies.length === 0 ? (
            <p className="border-l-2 border-rule-strong bg-panel px-4 py-3 text-[13px] text-dim">Save a strategy in the Strategies view first. A grant always covers one exact strategy.</p>
          ) : (
            <form
              className="space-y-3.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (consent && selected) authorize();
              }}
            >
              <label className="block">
                <span className="text-[12.5px] text-dim">Strategy</span>
                <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)} className="mt-1 block h-9 w-full rounded-[3px] border border-rule-strong bg-ink px-2 text-text">
                  <option value="">Choose a saved strategy</option>
                  {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <NumberInput label="Max per trade (USD)" value={maxTrade} onChange={setMaxTrade} min={1} max={selected?.strategy.maximumTradeUsd ?? 10_000} step={1} note={selected ? `Strategy allows up to $${selected.strategy.maximumTradeUsd}` : undefined} />
                <NumberInput label="Max trades per day" value={perDay} onChange={setPerDay} min={1} max={20} step={1} />
                <NumberInput label="Daily cap (USD)" value={dailyCap} onChange={setDailyCap} min={1} max={50_000} step={1} />
                <label className="block">
                  <span className="text-[12.5px] text-dim">Duration</span>
                  <select value={hours} onChange={(e) => setHours(Number(e.target.value))} className="mt-1 block h-9 w-full rounded-[3px] border border-rule-strong bg-ink px-2 text-text">
                    <option value={1}>1 hour</option>
                    <option value={24}>24 hours</option>
                    <option value={168}>7 days</option>
                  </select>
                </label>
              </div>
              <label className="flex items-start gap-2.5 text-[13px]">
                <input type="checkbox" className="mt-0.5 accent-[#f0a73a]" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                <span>I authorize the agent to execute this strategy autonomously within these limits. In this web app, execution is simulated.</span>
              </label>
              <Button type="submit" variant="primary" disabled={!selected || !consent || busy !== null || maxTrade > (selected?.strategy.maximumTradeUsd ?? 0)}>
                {busy === "grant" ? "Authorizing…" : "Authorize simulated autonomy"}
              </Button>
            </form>
          )}

          {message && (
            <p role="status" className={`text-[13px] ${message.tone === "ok" ? "text-exec" : message.tone === "warn" ? "text-act" : "text-danger"}`}>{message.text}</p>
          )}

          <div className="border border-rule bg-panel px-4 py-3.5 text-[13px]">
            <div className="flex items-center gap-2">
              <p className="font-medium">Live execution</p>
              <ModeBadge mode="LIVE" />
              <span className="ml-auto text-[12px] text-dim">Local agent only</span>
            </div>
            <p className="mt-1.5 text-dim">
              Live trades go through the Binance Agentic Wallet, which needs your signed-in desktop session, so they never run from this website. Run the local agent:
            </p>
            <pre className="num mt-2 overflow-x-auto rounded-[3px] bg-ink px-3 py-2 text-[11.5px] leading-relaxed text-text">{`npm i -g @binance/agentic-wallet && baw auth signin
npm run agent -- init --from gappilot-export.json \\
  --provider binance-agentic-wallet --max-trade 25
GAPPILOT_EXECUTION_ENABLED=true \\
  npm run agent -- run --bundle agent-bundle.json --live`}</pre>
            <p className="mt-2 text-[12px] text-dim">
              Limitation: the Agentic Wallet routes its own trade, so it can&apos;t execute the exact transaction GapPilot simulated. The agent requires a passed simulation, checks that the wallet&apos;s own quote meets the simulated minimum, sends your slippage limit explicitly, and verifies the fill afterwards. Not yet verified against a live session.
            </p>
          </div>
        </section>

        <section aria-labelledby="audit-title" className="min-w-0 bg-ink px-4 py-5 lg:overflow-y-auto lg:px-6">
          <div className="flex items-baseline gap-3">
            <h2 id="audit-title" className="text-[17px] font-semibold tracking-tight">Audit log</h2>
            <span className="num text-[12px] text-faint">{records.length}</span>
            {records.length > 0 && <Button variant="ghost" onClick={() => audit?.clear()} className="ml-auto">Clear</Button>}
          </div>
          <p className="mt-1 text-[13px] text-dim">Every execution attempt, approved or autonomous, including refusals. The local agent keeps a hash-chained copy on disk.</p>
          {records.length === 0 ? (
            <p className="mt-4 border-l-2 border-rule-strong bg-panel px-4 py-3 text-[13px] text-dim">No executions yet. Approve a simulated trade from the Scanner, or run one autonomous cycle.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {records.map((r) => <li key={r.id}><AuditRecordCard record={r} /></li>)}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
