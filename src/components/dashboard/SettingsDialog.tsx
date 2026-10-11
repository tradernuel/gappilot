"use client";

import { useEffect, useRef, useState } from "react";
import type { Settings } from "@/lib/client/use-settings";
import type { UserRules } from "@/lib/agent/types";
import { Button } from "./states";

export function SettingsDialog({ open, settings, onSave, onClose }: { open: boolean; settings: Settings; onSave: (s: Partial<Settings>) => void; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState(settings);

  useEffect(() => setDraft(settings), [settings, open]);
  const setRule = <K extends keyof UserRules>(k: K, v: UserRules[K]) => setDraft((d) => ({ ...d, rules: { ...d.rules, [k]: v } }));
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-labelledby="settings-title"
      className="m-auto max-h-[90dvh] w-[min(92vw,460px)] overflow-y-auto rounded-[4px] border border-rule-strong bg-panel p-0 text-text backdrop:bg-ink/70"
    >
      <form
        method="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(draft);
          onClose();
        }}
      >
        <div className="border-b border-rule px-5 py-3.5">
          <h2 id="settings-title" className="font-medium">Settings</h2>
        </div>
        <div className="space-y-4 px-5 py-4 text-[13px]">
          <label className="block">
            <span className="text-dim">Trade size to evaluate (USD)</span>
            <input
              type="number"
              min={1}
              max={1_000_000}
              step="any"
              required
              value={draft.notional}
              onChange={(e) => setDraft({ ...draft, notional: Number(e.target.value) })}
              className="num mt-1 block h-9 w-full rounded-[3px] border border-rule-strong bg-ink px-2.5 text-text"
            />
            <span className="mt-1 block text-[12px] text-faint">Costs, liquidity and your balances are checked at this size.</span>
          </label>
          <label className="block">
            <span className="text-dim">Ticker pairs to scan</span>
            <input
              type="number"
              min={1}
              max={25}
              step={1}
              required
              value={draft.maxPairs}
              onChange={(e) => setDraft({ ...draft, maxPairs: Number(e.target.value) })}
              className="num mt-1 block h-9 w-full rounded-[3px] border border-rule-strong bg-ink px-2.5 text-text"
            />
          </label>
          <fieldset>
            <legend className="text-dim">Auto-refresh</legend>
            <div className="mt-1.5 flex gap-1.5">
              {([0, 30, 60] as const).map((s) => (
                <label key={s} className={`cursor-pointer rounded-[3px] border px-3 py-1.5 ${draft.refreshSec === s ? "border-brand text-brand" : "border-rule-strong text-dim"}`}>
                  <input type="radio" name="refresh" className="sr-only" checked={draft.refreshSec === s} onChange={() => setDraft({ ...draft, refreshSec: s })} />
                  {s === 0 ? "Off" : `${s} s`}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset className="space-y-3.5 border-t border-rule px-5 py-4 text-[13px]">
          <legend className="sr-only">Agent rules</legend>
          <div>
            <p className="font-medium">Agent rules</p>
            <p className="mt-0.5 text-[12px] text-faint">The agent only marks a trade executable if all of these hold. They can make it stricter than the engine, never looser.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <NumberField label="Max trade size (USD)" value={draft.rules.maxNotionalUsd} min={1} max={1_000_000} step="any" onChange={(v) => setRule("maxNotionalUsd", v)} />
            <NumberField label="Min net edge (%)" value={draft.rules.minNetEdgePercent} min={0} max={50} step={0.05} onChange={(v) => setRule("minNetEdgePercent", v)} />
            <NumberField label="Max slippage (%)" value={draft.rules.maxSlippagePercent} min={0} max={10} step={0.05} onChange={(v) => setRule("maxSlippagePercent", v)} />
            <NumberField label="Max reference age (h)" value={draft.rules.maxReferenceAgeHours} min={0} max={720} step={1} onChange={(v) => setRule("maxReferenceAgeHours", v)} />
          </div>
          <label className="block">
            <span className="text-dim">Minimum confidence</span>
            <select
              value={draft.rules.minConfidence}
              onChange={(e) => setRule("minConfidence", e.target.value as UserRules["minConfidence"])}
              className="mt-1 block h-9 w-full rounded-[3px] border border-rule-strong bg-ink px-2 text-text"
            >
              <option value="LOW">Low</option>
              <option value="MEDIUM">Medium</option>
              <option value="HIGH">High</option>
            </select>
          </label>
          <label className="flex items-start gap-2.5">
            <input type="checkbox" className="mt-0.5 accent-[#f0a73a]" checked={draft.rules.allowMarketClosed} onChange={(e) => setRule("allowMarketClosed", e.target.checked)} />
            <span>
              Allow trades while the US market is closed
              <span className="block text-[12px] text-faint">Off-hours gaps may reflect news since the close.</span>
            </span>
          </label>
        </fieldset>
        <div className="flex justify-end gap-2 border-t border-rule px-5 py-3">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit">Save settings</Button>
        </div>
      </form>
    </dialog>
  );
}

function NumberField({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number | "any"; onChange: (v: number) => void }) {
  return (
    <label className="block">
      <span className="text-[12.5px] text-dim">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        required
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="num mt-1 block h-9 w-full rounded-[3px] border border-rule-strong bg-ink px-2.5 text-text"
      />
    </label>
  );
}
