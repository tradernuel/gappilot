"use client";

import { useMemo, useRef, useState } from "react";
import type { Opportunity } from "@/lib/engine/types";
import { parseStrategy, type ParseResponse } from "@/lib/client/api";
import type { useStrategies } from "@/lib/client/use-strategies";
import { describeStrategy } from "@/lib/strategy/describe";
import { matchStrategy } from "@/lib/strategy/match";
import { STRATEGY_LIMITS, type Strategy } from "@/lib/strategy/schema";
import { Button } from "./states";

const EXAMPLES = [
  "Buy tokenized stocks when they are at least 2% below reference price. Only trade when liquidity is above $100k. Maximum $50 per trade.",
  "Sell Ondo tokens when they are 3% above reference, slippage under 0.4%, only during market hours. Max $75 per trade.",
];

type ParseState = { phase: "idle" } | { phase: "loading" } | { phase: "done"; result: ParseResponse } | { phase: "error"; message: string };

export function StrategiesView({ opportunities, hasScan, store }: { opportunities: Opportunity[]; hasScan: boolean; store: ReturnType<typeof useStrategies> }) {
  const [text, setText] = useState("");
  const [state, setState] = useState<ParseState>({ phase: "idle" });
  const [savedId, setSavedId] = useState<string | null>(null);
  const { saved, save, remove, dropped } = store;
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const parse = async () => {
    setSavedId(null);
    setState({ phase: "loading" });
    const r = await parseStrategy(text);
    setState("error" in r ? { phase: "error", message: r.error } : { phase: "done", result: r });
  };

  return (
    <div className="grid gap-px bg-rule lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <section aria-labelledby="builder-title" className="min-w-0 bg-ink px-4 py-5 lg:overflow-y-auto lg:px-6">
        <h2 id="builder-title" className="text-[17px] font-semibold tracking-tight">Describe a rule</h2>
        <p className="mt-1 max-w-[62ch] text-[13px] text-dim">
          Write it in plain English. GapPilot turns it into a strategy you can check before saving. Saving never places a trade.
        </p>

        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) parse();
          }}
        >
          <label htmlFor="rule-text" className="sr-only">Rule</label>
          <textarea
            id="rule-text"
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && text.trim()) parse();
            }}
            rows={4}
            maxLength={STRATEGY_LIMITS.maxTextLength}
            placeholder="Buy tokenized stocks when they are at least 2% below reference price…"
            className="block w-full resize-y rounded-[3px] border border-rule-strong bg-panel px-3 py-2.5 text-[14px] leading-relaxed text-text placeholder:text-faint"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" disabled={!text.trim() || state.phase === "loading"}>
              {state.phase === "loading" ? "Parsing…" : "Parse rule"}
            </Button>
            <span className="num text-[12px] text-faint">{text.length}/{STRATEGY_LIMITS.maxTextLength}</span>
          </div>
        </form>

        <div className="mt-3 text-[12px] text-dim">
          <span>Try:</span>
          <ul className="mt-1.5 space-y-1.5">
            {EXAMPLES.map((ex) => (
              <li key={ex}>
                <button type="button" onClick={() => { setText(ex); setState({ phase: "idle" }); inputRef.current?.focus(); }} className="text-left text-dim underline decoration-rule-strong underline-offset-2 hover:text-text">
                  {ex}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6" aria-live="polite">
          {state.phase === "error" && <p role="alert" className="border-l-2 border-danger/60 bg-panel px-4 py-3 text-[13px] text-danger">{state.message}</p>}
          {state.phase === "done" && (
            <ParsedRule
              result={state.result}
              savedId={savedId}
              onSave={(s, name) => {
                const entry = save(s, name);
                if (entry) setSavedId(entry.id);
              }}
              onEdit={() => inputRef.current?.focus()}
            />
          )}
        </div>
      </section>

      <section aria-labelledby="saved-title" className="min-w-0 bg-ink px-4 py-5 lg:overflow-y-auto lg:px-6">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id="saved-title" className="text-[17px] font-semibold tracking-tight">Saved strategies</h2>
          <span className="num text-[12px] text-faint">{saved.length}</span>
        </div>
        <p className="mt-1 text-[13px] text-dim">
          Stored in this browser. Matches show which opportunities in the latest scan a rule would flag for review. Nothing is executed.
        </p>
        {dropped > 0 && <p className="mt-2 text-[12px] text-act">{dropped} saved {dropped === 1 ? "entry was" : "entries were"} invalid and removed.</p>}

        {saved.length === 0 ? (
          <p className="mt-6 border-l-2 border-rule-strong bg-panel px-4 py-3 text-[13px] text-dim">No saved strategies yet. Parse a rule, check it, then save it.</p>
        ) : (
          <ul className="mt-4 space-y-3">
            {saved.map((entry) => (
              <SavedCard key={entry.id} name={entry.name} strategy={entry.strategy} createdAt={entry.createdAt} opportunities={opportunities} hasScan={hasScan} onDelete={() => remove(entry.id)} highlight={entry.id === savedId} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ParsedRule({ result, savedId, onSave, onEdit }: { result: ParseResponse; savedId: string | null; onSave: (s: Strategy, name: string) => void; onEdit: () => void }) {
  if (!result.ok || !result.strategy) {
    return (
      <div className="border border-danger/40 bg-panel">
        <div className="border-b border-danger/30 px-4 py-2.5">
          <p className="font-medium text-danger">This rule can&apos;t be saved</p>
        </div>
        <ul className="space-y-2 px-4 py-3 text-[13px] leading-relaxed">
          {result.errors.map((e, i) => (
            <li key={i} className="flex gap-2.5">
              <span aria-hidden className="mt-[1px] text-danger">✕</span>
              <span>{e.message}</span>
            </li>
          ))}
        </ul>
        <div className="border-t border-rule px-4 py-2.5 text-[12px] text-dim">
          {result.parserNote} <button className="ml-1 text-text underline underline-offset-2" onClick={onEdit}>Edit the rule</button>
        </div>
      </div>
    );
  }

  const d = describeStrategy(result.strategy, result.defaultsApplied);
  const isBuy = result.strategy.action === "BUY";
  return (
    <div className="border border-rule-strong bg-panel">
      <div className="flex items-baseline justify-between border-b border-rule px-4 py-2.5">
        <p className="text-[12px] text-dim">Your rule</p>
        <p className="text-[12px] text-faint">Check it before saving</p>
      </div>
      <div className="px-4 pt-4">
        <p className={`text-[30px] leading-none font-semibold tracking-tight ${isBuy ? "text-discount" : "text-premium"}`}>{d.headline}</p>
      </div>
      <dl className="mt-3 divide-y divide-rule/70 border-t border-rule/70">
        {d.lines.map((l) => (
          <div key={l.label} className="grid grid-cols-[120px_1fr] gap-3 px-4 py-2 text-[13.5px]">
            <dt className="text-dim">{l.label}</dt>
            <dd className={l.label === "Simulation" ? "font-medium text-exec" : ""}>
              <span className={l.label === "When" || l.label === "Liquidity" || l.label === "Max trade" || l.label === "Max slippage" ? "num" : ""}>{l.value}</span>
              {l.isDefault && <span className="ml-2 rounded-[3px] border border-rule-strong px-1.5 py-[1px] text-[11px] text-dim" title="You didn't specify this, so GapPilot's default is used.">default</span>}
            </dd>
          </div>
        ))}
      </dl>
      {result.warnings.length > 0 && (
        <ul className="space-y-1.5 border-t border-rule/70 px-4 py-3 text-[12.5px] text-act">
          {result.warnings.map((w, i) => <li key={i}>{w.message}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3 border-t border-rule px-4 py-3">
        {savedId ? (
          <p role="status" className="text-[13px] text-exec">Saved. It won&apos;t place any trades.</p>
        ) : (
          <Button variant="primary" onClick={() => onSave(result.strategy!, d.name)}>Save strategy</Button>
        )}
        <Button variant="ghost" onClick={onEdit}>Edit rule</Button>
        <span className="ml-auto text-[12px] text-faint">{result.parserNote}</span>
      </div>
    </div>
  );
}

function SavedCard({ name, strategy, createdAt, opportunities, hasScan, onDelete, highlight }: { name: string; strategy: Strategy; createdAt: number; opportunities: Opportunity[]; hasScan: boolean; onDelete: () => void; highlight: boolean }) {
  const d = describeStrategy(strategy);
  const matches = useMemo(() => opportunities.filter((o) => matchStrategy(strategy, o).matches), [opportunities, strategy]);
  const [confirming, setConfirming] = useState(false);
  return (
    <li className={`border bg-panel ${highlight ? "border-exec/50" : "border-rule"}`}>
      <div className="flex items-start gap-3 px-4 py-3">
        <span className={`mt-0.5 rounded-[3px] px-1.5 py-0.5 text-[11.5px] font-semibold ${strategy.action === "BUY" ? "bg-discount/15 text-discount" : "bg-premium/15 text-premium"}`}>{strategy.action}</span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{name}</p>
          <p className="mt-0.5 text-[12px] text-dim">
            {d.lines.find((l) => l.label === "When")!.value}. Liquidity {strategy.minimumLiquidityUsd.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} or more, max ${strategy.maximumTradeUsd} per trade, slippage up to {strategy.maximumSlippagePercent.toFixed(2)}%, {({ ANY: "any time", OPEN_ONLY: "market hours only", CLOSED_ONLY: "off-hours only" } as const)[strategy.marketStatus]}. Simulation required.
          </p>
          <p className="mt-0.5 text-[11.5px] text-faint">Saved {new Date(createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</p>
        </div>
        {confirming ? (
          <span className="flex gap-1">
            <Button variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
            <Button variant="secondary" onClick={onDelete} className="border-danger/50 text-danger">Delete</Button>
          </span>
        ) : (
          <Button variant="ghost" onClick={() => setConfirming(true)} aria-label={`Delete ${name}`}>Delete</Button>
        )}
      </div>
      <div className="border-t border-rule/70 px-4 py-2 text-[12.5px]">
        {!hasScan ? (
          <span className="text-faint">Matches appear after a scan.</span>
        ) : matches.length === 0 ? (
          <span className="text-dim">No opportunity in the latest scan matches.</span>
        ) : (
          <span>
            <span className="text-exec">{matches.length} match{matches.length > 1 ? "es" : ""}</span>{" "}
            <span className="text-dim">in the latest scan: {matches.map((m) => m.asset.symbol).join(", ")}. Review only; nothing is executed.</span>
          </span>
        )}
      </div>
    </li>
  );
}
