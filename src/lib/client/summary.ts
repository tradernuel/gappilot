import type { Opportunity } from "../engine/types";

export interface Summary {
  scanned: number;
  detected: number;
  actionable: number;
  executable: number;
  avgAbsSpread: number | null;
  avgOver: number;
  market: { label: string; detail: string | null; tone: "open" | "closed" | "restricted" | "unknown" };
}

/** Pure aggregation for the summary strip. "Detected" excludes IGNORE (noise, invalid, halted). */
export function summarize(list: Opportunity[]): Summary {
  const detected = list.filter((o) => o.action !== "IGNORE");
  const actionable = list.filter((o) => o.action === "ACTIONABLE" || o.action === "EXECUTABLE");
  const pool = detected.length ? detected : list;
  const avg = pool.length ? pool.reduce((s, o) => s + Math.abs(o.spreadPercent), 0) / pool.length : null;

  // All tokenized US equities share one underlying market; use the most common reported state.
  const states = list.map((o) => o.marketStatus).filter((m) => m.available);
  let market: Summary["market"] = { label: "Unknown", detail: "Market status not reported", tone: "unknown" };
  if (states.length) {
    const open = states.filter((m) => m.openState === true).length;
    const restricted = states.filter((m) => m.isHardBlocked).length;
    const closed = states.length - open;
    const next = states.map((m) => m.nextOpenTime).filter((t): t is number => typeof t === "number").sort((a, b) => a - b)[0] ?? null;
    if (open >= closed) {
      const session = states.find((m) => m.openState)?.marketStatus;
      market = { label: "US equities open", detail: session ? `Session: ${session}` : null, tone: "open" };
    } else {
      const reason = states.find((m) => !m.openState && m.reasonMsg)?.reasonMsg ?? null;
      market = {
        label: "US equities closed",
        detail: next ? `Opens ${new Date(next).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}` : reason,
        tone: "closed",
      };
    }
    if (restricted > 0) market.detail = `${market.detail ? `${market.detail}. ` : ""}${restricted} restricted`;
  }

  return {
    scanned: list.length,
    detected: detected.length,
    actionable: actionable.length,
    executable: list.filter((o) => o.action === "EXECUTABLE").length,
    avgAbsSpread: avg,
    avgOver: pool.length,
    market,
  };
}
