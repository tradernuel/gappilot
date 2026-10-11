"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OpportunityAction } from "@/lib/engine/types";
import { ApiError, fetchScan, type DashboardScan } from "@/lib/client/api";
import { summarize } from "@/lib/client/summary";
import { useSettings } from "@/lib/client/use-settings";
import { useWallet } from "@/lib/client/use-wallet";
import { useStrategies } from "@/lib/client/use-strategies";
import { DetailPanel } from "./DetailPanel";
import { Header } from "./Header";
import { OpportunityTable } from "./OpportunityTable";
import { SettingsDialog } from "./SettingsDialog";
import { SummaryStrip } from "./SummaryStrip";
import { StrategiesView } from "./StrategiesView";
import { AutonomyView } from "./AutonomyView";
import { WeekendPanel } from "./WeekendPanel";
import { deriveWeekendState } from "@/lib/client/weekend";
import { AuditContext, useAuditStore } from "@/lib/client/use-audit";
import { Button, Notice, TableSkeleton } from "./states";
import { ACTION_STYLE } from "./primitives";

type Filter = "ALL" | OpportunityAction;
const FILTERS: Filter[] = ["ALL", "EXECUTABLE", "ACTIONABLE", "WATCH", "IGNORE"];

/** Turns API failures into a direction, not a mood. */
function describeError(e: unknown): { title: string; body: string } {
  if (!(e instanceof ApiError)) return { title: "The scan failed", body: "An unexpected error occurred. Rescan to try again." };
  switch (e.kind) {
    case "config":
      return { title: "Server isn't configured", body: "Set BINANCE_WEB3_API_KEY, BINANCE_WEB3_API_SECRET and GAPPILOT_QUOTE_TOKEN_ADDRESS in the server environment, then redeploy." };
    case "rate_limited":
      return { title: "Too many scans", body: e.message };
    case "timeout":
      return { title: "Binance didn't respond in time", body: "The Web3 API timed out. Rescan in a moment." };
    case "offline":
      return { title: "Can't reach GapPilot", body: "Check your connection, then rescan." };
    case "http":
      if (e.upstreamStatus === 401 || e.upstreamStatus === 403) {
        return {
          title: "Binance rejected the request",
          body: `The Web3 API returned HTTP ${e.upstreamStatus}. Check the API key and secret, and that the server's region can reach web3.binance.com.`,
        };
      }
      if (e.upstreamStatus === 429) return { title: "Binance rate limit reached", body: "Wait a minute, then rescan." };
      return { title: "Binance returned an error", body: e.message };
    case "business":
      return { title: "Binance rejected the query", body: e.message };
    case "parse":
      return { title: "Unexpected data from Binance", body: `${e.message}. This is logged; rescan to retry.` };
    default:
      return { title: "The scan failed", body: e.message };
  }
}

export function Dashboard() {
  const { settings, update, loaded } = useSettings();
  const { state: wallet, connect, disconnect, switchToBsc } = useWallet();
  const walletForScan = wallet.status === "connected" && wallet.onBsc ? wallet.address : undefined;
  const strategies = useStrategies();
  const auditStore = useAuditStore();

  const [scan, setScan] = useState<DashboardScan | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("ALL");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [view, setView] = useState<"scanner" | "strategies" | "autonomy">("scanner");
  const [weekendOn, setWeekendOn] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem("gappilot:weekend:v1") === "off") setWeekendOn(false);
    } catch {
      /* ignore */
    }
  }, []);
  const changeWeekend = (v: boolean) => {
    setWeekendOn(v);
    try {
      localStorage.setItem("gappilot:weekend:v1", v ? "on" : "off");
    } catch {
      /* ignore */
    }
  };
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLoading(true);
    try {
      const data = await fetchScan({ notional: settings.notional, maxPairs: settings.maxPairs, wallet: walletForScan }, ctrl.signal);
      setScan(data);
      setError(null);
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(e);
    } finally {
      if (abortRef.current === ctrl) setLoading(false);
    }
  }, [settings.notional, settings.maxPairs, walletForScan]);

  useEffect(() => {
    if (loaded) run();
    return () => abortRef.current?.abort();
  }, [loaded, run]);

  // Weekend Mode keeps a closed-market scan fresh (30 s) unless the user set their own interval.
  const weekend = useMemo(() => deriveWeekendState(scan), [scan]);
  const weekendActive = weekendOn && weekend.status === "ACTIVE";
  const refreshSec = settings.refreshSec || (weekendActive ? 30 : 0);
  useEffect(() => {
    if (!refreshSec) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, refreshSec * 1000);
    return () => clearInterval(id);
  }, [refreshSec, run]);

  const opportunities = scan?.opportunities ?? [];
  const summary = useMemo(() => (scan ? summarize(opportunities) : null), [scan, opportunities]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { ALL: opportunities.length, EXECUTABLE: 0, ACTIONABLE: 0, WATCH: 0, IGNORE: 0 };
    for (const o of opportunities) c[o.action]++;
    return c;
  }, [opportunities]);
  const rows = filter === "ALL" ? opportunities : opportunities.filter((o) => o.action === filter);
  // One scale for every bar so lengths compare across rows.
  const scale = useMemo(() => Math.max(0.5, ...opportunities.map((o) => Math.abs(o.spreadPercent))), [opportunities]);
  const current = opportunities.find((o) => o.asset.address === selected) ?? null;
  const close = useCallback(() => setSelected(null), []);

  const err = error ? describeError(error) : null;

  let body: React.ReactNode;
  if (loading && !scan) {
    body = <TableSkeleton />;
  } else if (err && !scan) {
    body = <Notice tone="error" title={err.title} action={<Button onClick={run}>Rescan</Button>}>{err.body}</Notice>;
  } else if (scan && scan.pairsFound === 0) {
    body = (
      <Notice tone="neutral" title="No stock is listed by two issuers right now">
        GapPilot compares the same stock across bStocks and Ondo on BNB Smart Chain. This scan found no ticker offered by both, so there is nothing to compare yet. Rescan later or check the issuers' listings.
      </Notice>
    );
  } else if (rows.length === 0) {
    body = (
      <Notice tone="neutral" title={`Nothing marked ${ACTION_STYLE[filter as OpportunityAction]?.label.toLowerCase() ?? "here"}`}>
        {filter === "EXECUTABLE" && !walletForScan ? "Connect a wallet on BNB Smart Chain to check what you can execute." : "Choose another filter to see the rest of the scan."}
      </Notice>
    );
  } else {
    body = <OpportunityTable rows={rows} selected={selected} onSelect={setSelected} scale={scale} />;
  }

  return (
    <AuditContext.Provider value={auditStore}>
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <Header
        wallet={wallet}
        onConnect={connect}
        onDisconnect={disconnect}
        onSwitchChain={switchToBsc}
        onOpenSettings={() => setSettingsOpen(true)}
        onRescan={run}
        scanning={loading}
        updatedAt={scan?.evaluatedAt ?? null}
        view={view}
        onViewChange={setView}
        weekendOn={weekendOn}
        weekendActive={weekend.status === "ACTIVE"}
        onWeekendChange={changeWeekend}
      />

      {wallet.status === "connected" && !wallet.onBsc && (
        <p role="status" className="border-b border-act/30 bg-act/10 px-4 py-2 text-[13px] text-act lg:px-6">
          Your wallet is on another network. Switch to BNB Smart Chain to include your balances.
        </p>
      )}
      {wallet.status === "disconnected" && wallet.error && (
        <p role="status" className="border-b border-rule bg-panel px-4 py-2 text-[13px] text-dim lg:px-6">{wallet.error}</p>
      )}
      {err && scan && (
        <p role="alert" className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-[13px] text-danger lg:px-6">
          {err.title}. Showing the previous scan. {err.body}
        </p>
      )}

      {view === "strategies" ? (
        <div className="flex-1 lg:min-h-0">
          <StrategiesView opportunities={opportunities} hasScan={!!scan} store={strategies} />
        </div>
      ) : view === "autonomy" ? (
        <div className="flex-1 lg:min-h-0">
          <AutonomyView strategies={strategies.saved} rules={settings.rules} wallet={walletForScan ?? null} />
        </div>
      ) : (
      <>
      {weekendOn ? (
        <WeekendPanel state={weekend} loading={loading} updatedAt={scan?.evaluatedAt ?? null} refreshSec={refreshSec || 30} />
      ) : (
        <SummaryStrip summary={summary} loading={loading} />
      )}

      <div className={`flex-1 lg:grid lg:min-h-0 lg:grid-rows-[minmax(0,1fr)] ${current ? "lg:grid-cols-[minmax(0,1fr)_440px]" : "lg:grid-cols-1"}`}>
        <main className="relative min-w-0 lg:overflow-y-auto">
          {scan && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-4 py-2.5 lg:px-6">
            <div role="tablist" aria-label="Filter by action" className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1">
              {FILTERS.map((f) => (
                <button
                  key={f}
                  role="tab"
                  aria-selected={filter === f}
                  onClick={() => setFilter(f)}
                  className={`shrink-0 rounded-[3px] px-2.5 py-1 text-[12.5px] ${filter === f ? "bg-raised text-text" : "text-dim hover:text-text"}`}
                >
                  {f === "ALL" ? "All" : ACTION_STYLE[f].label}
                  <span className="num ml-1.5 text-faint">{counts[f]}</span>
                </button>
              ))}
            </div>
            {scan && (
              <p className="ml-auto text-[12px] text-dim">
                Same stock across issuers, per share, at <span className="num text-text">${settings.notional.toLocaleString("en-US")}</span> trade size.
                {!walletForScan && " Connect a wallet to price execution."}
              </p>
            )}
          </div>
          )}

          {body}

          {scan && scan.errors.length > 0 && (
            <details className="mx-4 my-3 text-[12px] text-dim lg:mx-6">
              <summary className="cursor-pointer">Some data was unavailable ({scan.errors.length})</summary>
              <ul className="mt-1.5 space-y-1 pl-4">
                {scan.errors.map((e, i) => (
                  <li key={i}><span className="num text-faint">{e.source}</span> {e.message}</li>
                ))}
              </ul>
            </details>
          )}
        </main>

        {current && (
          <aside
            aria-label="Opportunity details"
            className="fixed inset-0 z-40 overflow-hidden bg-panel lg:relative lg:z-auto lg:h-full lg:min-h-0 lg:border-l lg:border-rule"
          >
            <DetailPanel opportunity={current} attestation={scan?.attestations[current.asset.address]} rules={settings.rules} walletAddress={walletForScan ?? null} strategies={strategies.saved} onClose={close} />
          </aside>
        )}
      </div>

      </>
      )}

      <SettingsDialog open={settingsOpen} settings={settings} onSave={update} onClose={() => setSettingsOpen(false)} />
    </div>
    </AuditContext.Provider>
  );
}
