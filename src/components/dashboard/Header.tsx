"use client";

import { fmtClock, shortAddress } from "@/lib/client/format";
import type { WalletState } from "@/lib/client/use-wallet";
import { LogoMark } from "./primitives";
import { Button } from "./states";
import { WeekendToggle } from "./WeekendPanel";

export function Header(props: {
  wallet: WalletState;
  onConnect: () => void;
  onDisconnect: () => void;
  onSwitchChain: () => void;
  onOpenSettings: () => void;
  onRescan: () => void;
  scanning: boolean;
  updatedAt: number | null;
  view: "scanner" | "strategies" | "autonomy";
  onViewChange: (v: "scanner" | "strategies" | "autonomy") => void;
  weekendOn: boolean;
  weekendActive: boolean;
  onWeekendChange: (v: boolean) => void;
}) {
  const { wallet } = props;
  const wrongChain = wallet.status === "connected" && !wallet.onBsc;

  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-ink/95 backdrop-blur supports-[backdrop-filter]:bg-ink/80">
      <div className="flex flex-wrap items-center gap-x-2 px-3 sm:gap-x-3 sm:px-4 lg:h-14 lg:flex-nowrap lg:px-6">
        <a href="/" className="flex h-12 items-center gap-2 lg:h-auto" aria-label="GapPilot home">
          <LogoMark className="h-6 w-6" />
          <span className="hidden text-[17px] font-semibold tracking-tight sm:inline">GapPilot</span>
        </a>

        <span
          className={`ml-1 inline-flex items-center gap-1.5 rounded-[3px] border px-1.5 py-0.5 text-[12px] sm:px-2 ${
            wrongChain ? "border-act/50 text-act" : "border-rule-strong text-dim"
          }`}
          title={wrongChain ? "Your wallet is on another network" : "BNB Smart Chain mainnet (chain 56)"}
        >
          <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${wrongChain ? "bg-act" : "bg-exec"}`} />
          <span className="sm:hidden">BSC</span>
          <span className="hidden sm:inline">BNB Smart Chain</span>
        </span>

        <nav aria-label="Views" className="order-last -mx-3 flex w-[calc(100%+1.5rem)] gap-0.5 border-t border-rule px-3 py-1.5 sm:-mx-4 sm:w-[calc(100%+2rem)] sm:px-4 lg:order-none lg:mx-0 lg:ml-2 lg:w-auto lg:border-0 lg:p-0">
          {(["scanner", "strategies", "autonomy"] as const).map((v) => (
            <button
              key={v}
              onClick={() => props.onViewChange(v)}
              aria-current={props.view === v ? "page" : undefined}
              className={`flex-1 rounded-[3px] px-2 py-1 text-[13px] lg:flex-none lg:px-2.5 ${props.view === v ? "bg-raised text-text" : "text-dim hover:text-text"}`}
            >
              {v === "scanner" ? "Scanner" : v === "strategies" ? "Strategies" : "Autonomy"}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
          <WeekendToggle on={props.weekendOn} active={props.weekendActive} onChange={props.onWeekendChange} />
          <span
            className="hidden items-center rounded-[3px] border border-watch/50 px-1.5 py-0.5 text-[11px] font-semibold tracking-wide text-watch lg:inline-flex"
            style={{ backgroundImage: "repeating-linear-gradient(135deg, rgba(142,159,207,.16) 0 4px, transparent 4px 8px)" }}
            title="This web app never sends transactions. Live execution runs only in the local agent."
          >
            SIMULATED EXECUTION
          </span>
          <span className="hidden text-[12px] text-dim md:inline" aria-live="polite">
            {props.scanning ? "Scanning…" : props.updatedAt ? <>Updated <span className="num">{fmtClock(props.updatedAt)}</span></> : null}
          </span>
          <Button variant="ghost" onClick={props.onRescan} disabled={props.scanning} aria-label="Rescan">
            <svg aria-hidden viewBox="0 0 16 16" className={`h-3.5 w-3.5 ${props.scanning ? "motion-safe:animate-spin" : ""}`}>
              <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            <span className="hidden sm:inline">Rescan</span>
          </Button>
          <Button variant="ghost" onClick={props.onOpenSettings} aria-label="Settings">
            <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4">
              <path d="M2 4h7M12 4h2M2 12h2M7 12h7M9 2.5v3M5 10.5v3" stroke="currentColor" strokeWidth="1.5" fill="none" />
            </svg>
          </Button>

          {wallet.status === "connected" ? (
            wrongChain ? (
              <Button variant="secondary" onClick={props.onSwitchChain} className="border-act/60 text-act">
                Switch to BSC
              </Button>
            ) : (
              <Button variant="secondary" onClick={props.onDisconnect} title="Disconnect from GapPilot">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-exec" />
                <span className="num">{shortAddress(wallet.address)}</span>
              </Button>
            )
          ) : wallet.status === "unavailable" ? (
            <Button variant="secondary" disabled title="Install a browser wallet such as Binance Wallet or MetaMask">
              <span className="sm:hidden">No wallet</span>
              <span className="hidden sm:inline">No wallet found</span>
            </Button>
          ) : (
            <Button variant="primary" onClick={props.onConnect} disabled={wallet.status === "connecting"}>
              {wallet.status === "connecting" ? "Connecting…" : <><span className="sm:hidden">Connect</span><span className="hidden sm:inline">Connect wallet</span></>}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
