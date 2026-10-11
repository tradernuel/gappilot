"use client";

import { useEffect, useState } from "react";
import { DEMO_WALLET, demoState, type DemoMarket } from "./backend";

/** DEMO ONLY. Floating control bar: market state, demo wallet, reset. */
export function DemoBar() {
  const [open, setOpen] = useState(false);
  const [market, setMarket] = useState<DemoMarket>(demoState.market);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1500);
    return () => clearInterval(id);
  }, []);

  const setMkt = (m: DemoMarket) => {
    demoState.market = m;
    setMarket(m);
    (document.querySelector('[aria-label="Rescan"]') as HTMLButtonElement | null)?.click();
  };
  const reset = () => {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith("gappilot:")).forEach((k) => localStorage.removeItem(k));
    } catch {
      /* ignore */
    }
    location.reload();
  };
  const holdings = Object.entries(demoState.holdings).filter(([, v]) => v > 0);

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} aria-label="Open demo controls" className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+12px)] left-3 z-50 flex items-center gap-2 rounded-full border border-watch/60 bg-panel px-3 py-1.5 text-[11.5px] font-semibold tracking-wide text-watch shadow-lg">
        DEMO DATA
        <span className={`font-medium ${market === "CLOSED" ? "text-act" : "text-exec"}`}>market {market.toLowerCase()}</span>
      </button>
    );
  }
  return (
    <aside aria-label="Demo controls" className="fixed bottom-[calc(env(safe-area-inset-bottom,0px)+12px)] left-3 z-50 w-[min(92vw,300px)] rounded-[4px] border border-watch/50 bg-panel text-[12.5px] shadow-2xl">
      <div className="flex items-center gap-2 border-b border-rule px-3 py-2">
        <span className="rounded-[3px] border border-watch/60 px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-watch" style={{ backgroundImage: "repeating-linear-gradient(135deg, rgba(142,159,207,.16) 0 4px, transparent 4px 8px)" }}>DEMO</span>
        <span className="font-medium">Test app</span>
        <button onClick={() => setOpen(false)} aria-label="Minimize demo controls" className="ml-auto px-1 text-dim hover:text-text">–</button>
      </div>
      <div className="space-y-2.5 px-3 py-2.5">
        <p className="text-dim">GapPilot&apos;s real engine, agent, simulation and execution policy, running on a simulated Binance API with fictional tickers. Execution is simulated.</p>
        <div>
          <p className="text-dim">Simulated US market</p>
          <div className="mt-1 flex gap-1" role="group" aria-label="Simulated US market">
            {(["CLOSED", "OPEN"] as const).map((m) => (
              <button key={m} onClick={() => setMkt(m)} aria-pressed={market === m} className={`flex-1 rounded-[3px] border px-2 py-1 font-medium ${market === m ? (m === "CLOSED" ? "border-act text-act" : "border-exec text-exec") : "border-rule-strong text-dim hover:text-text"}`}>
                {m === "CLOSED" ? "Closed" : "Open"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-dim">Demo wallet <span className="num text-faint">{DEMO_WALLET.slice(0, 6)}…{DEMO_WALLET.slice(-4)}</span></p>
          <p className="num mt-0.5">{demoState.usdt.toFixed(2)} USDT{holdings.map(([s, v]) => `, ${Number(v.toFixed(6))} ${s}`).join("")}</p>
        </div>
        <button onClick={reset} className="text-dim underline decoration-rule-strong underline-offset-2 hover:text-text">Reset demo</button>
      </div>
    </aside>
  );
}
