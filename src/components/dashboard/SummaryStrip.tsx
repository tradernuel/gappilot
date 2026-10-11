"use client";

import { fmtPct } from "@/lib/client/format";
import type { Summary } from "@/lib/client/summary";

function Cell({ label, value, detail, accent }: { label: string; value: React.ReactNode; detail?: React.ReactNode; accent?: string }) {
  return (
    <div className="min-w-0 bg-ink px-4 py-3 lg:px-6">
      <dt className="text-[12px] text-dim">{label}</dt>
      <dd className={`mt-0.5 text-[22px] leading-tight font-medium ${accent ?? ""}`}>{value}</dd>
      {detail && <dd className="mt-0.5 text-[12px] text-dim lg:truncate">{detail}</dd>}
    </div>
  );
}

export function SummaryStrip({ summary, loading }: { summary: Summary | null; loading: boolean }) {
  if (loading && !summary) {
    return (
      <div className="grid grid-cols-2 border-b border-rule lg:grid-cols-4" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2 px-4 py-3.5 lg:px-6">
            <div className="skeleton h-2.5 w-24" />
            <div className="skeleton h-5 w-14" />
          </div>
        ))}
      </div>
    );
  }
  if (!summary) return null;
  const marketTone =
    summary.market.tone === "open" ? "text-exec" : summary.market.tone === "closed" ? "text-act" : summary.market.tone === "restricted" ? "text-danger" : "text-dim";

  return (
    <dl className="grid grid-cols-2 gap-px border-b border-rule bg-rule lg:grid-cols-4">
      <Cell
        label="Opportunities detected"
        value={<span className="num">{summary.detected}</span>}
        detail={`of ${summary.scanned} tokens compared`}
      />
      <Cell
        label="Actionable"
        value={<span className="num">{summary.actionable}</span>}
        accent={summary.actionable ? "text-act" : undefined}
        detail={summary.executable ? <span className="text-exec">{summary.executable} executable from your wallet</span> : "none executable from this wallet"}
      />
      <Cell
        label="Average spread"
        value={<span className="num">{fmtPct(summary.avgAbsSpread)}</span>}
        detail={summary.avgOver ? `absolute, across ${summary.avgOver}` : "no data"}
      />
      <Cell label="Market status" value={<span className={`text-[17px] ${marketTone}`}>{summary.market.label}</span>} detail={summary.market.detail} />
    </dl>
  );
}
