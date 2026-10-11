/**
 * Weekend Mode: derived purely from the latest scan. No hardcoded figures.
 *
 * ACTIVE  — the scan reports the US equity market closed (weekend, holiday, overnight).
 * STANDBY — the market is open; Weekend Mode is on but has nothing special to do.
 * UNKNOWN — no scan yet, or the API didn't report market status.
 */
import type { Opportunity } from "../engine/types";
import { summarize } from "./summary";

export type WeekendStatus = "ACTIVE" | "STANDBY" | "UNKNOWN";

export interface WeekendState {
  status: WeekendStatus;
  marketLabel: "CLOSED" | "OPEN" | "UNKNOWN";
  /** API reason, e.g. "Weekend or Holiday". */
  reason: string | null;
  nextOpenTime: number | null;
  /** Tokenized equities discovered on BSC. */
  monitoring: number | null;
  /** Tokens compared across issuers this scan. */
  compared: number;
  opportunities: number;
  actionable: number;
  executable: number;
  avgAbsSpread: number | null;
  /** Some tokens are restricted (corporate action / halt). */
  restricted: number;
}

export function deriveWeekendState(scan: { opportunities: Opportunity[]; assetsDiscovered?: number } | null): WeekendState {
  const list = scan?.opportunities ?? [];
  const s = summarize(list);
  const states = list.map((o) => o.marketStatus).filter((m) => m.available);
  const nextOpen = states.map((m) => m.nextOpenTime).filter((t): t is number => typeof t === "number").sort((a, b) => a - b)[0] ?? null;
  const reason = states.find((m) => m.openState === false && m.reasonMsg)?.reasonMsg ?? null;
  const marketLabel = !scan || s.market.tone === "unknown" ? "UNKNOWN" : s.market.tone === "closed" ? "CLOSED" : "OPEN";
  return {
    status: marketLabel === "CLOSED" ? "ACTIVE" : marketLabel === "OPEN" ? "STANDBY" : "UNKNOWN",
    marketLabel,
    reason,
    nextOpenTime: marketLabel === "CLOSED" ? nextOpen : null,
    monitoring: scan ? (scan.assetsDiscovered ?? null) : null,
    compared: list.length,
    opportunities: s.detected,
    actionable: s.actionable,
    executable: s.executable,
    avgAbsSpread: s.avgAbsSpread,
    restricted: states.filter((m) => m.isHardBlocked).length,
  };
}

/** "1d 14h 22m", "3h 05m", "12m". Null when the time has passed or is unknown. */
export function formatCountdown(target: number | null, now: number): string | null {
  if (target === null || !(target > now)) return null;
  const mins = Math.floor((target - now) / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h ${String(m).padStart(2, "0")}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m`;
}
