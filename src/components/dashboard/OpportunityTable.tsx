"use client";

import type { KeyboardEvent } from "react";
import type { Opportunity } from "@/lib/engine/types";
import { fmtAgeHours, fmtCompactUsd, fmtPct, fmtPrice, fmtReferenceSource, issuerName } from "@/lib/client/format";
import { ACTION_STYLE, ActionBadge, ConfidenceMeter, GapBar, SpreadFigure } from "./primitives";

interface Props {
  rows: Opportunity[];
  selected: string | null;
  onSelect: (address: string) => void;
  scale: number;
}

const keyOpen = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

function NetFigure({ o }: { o: Opportunity }) {
  if (o.netOpportunityPercent === null) {
    return <span className="text-faint" title="No executable quote, so costs can't be estimated">—</span>;
  }
  const positive = o.netOpportunityPercent > 0;
  return <span className={`num ${positive ? "text-text" : "text-dim"}`}>{fmtPct(o.netOpportunityPercent, { signed: true })}</span>;
}

export function OpportunityTable({ rows, selected, onSelect, scale }: Props) {
  return (
    <>
      {/* ≥ md: dense table */}
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[880px] border-collapse text-left">
          <caption className="sr-only">Tokenized stock opportunities, strongest first. Select a row for details.</caption>
          <thead>
            <tr className="border-b border-rule text-[12px] text-dim">
              <th scope="col" className="py-2 pl-4 pr-3 font-normal lg:pl-6">Asset</th>
              <th scope="col" className="px-3 py-2 text-right font-normal">On-chain</th>
              <th scope="col" className="px-3 py-2 text-right font-normal">Reference</th>
              <th scope="col" className="w-[190px] px-3 py-2 font-normal">Spread</th>
              <th scope="col" className="px-3 py-2 text-right font-normal">Ref. age</th>
              <th scope="col" className="px-3 py-2 text-right font-normal">Liquidity</th>
              <th scope="col" className="px-3 py-2 text-right font-normal">Net</th>
              <th scope="col" className="px-3 py-2 font-normal">Confidence</th>
              <th scope="col" className="py-2 pl-3 pr-4 font-normal lg:pr-6">Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const isSel = selected === o.asset.address;
              const dim = o.action === "IGNORE";
              return (
                <tr
                  key={o.asset.address}
                  tabIndex={0}
                  aria-selected={isSel}
                  onClick={() => onSelect(o.asset.address)}
                  onKeyDown={keyOpen(() => onSelect(o.asset.address))}
                  className={`cursor-pointer border-b border-rule/70 outline-none transition-colors hover:bg-raised/60 focus-visible:bg-raised ${
                    isSel ? "bg-raised" : ""
                  } ${dim ? "text-dim" : ""}`}
                >
                  <td className="relative py-2.5 pl-4 pr-3 lg:pl-6">
                    <span aria-hidden className={`absolute inset-y-1.5 left-0 w-[3px] ${ACTION_STYLE[o.action].bar} ${isSel ? "" : "opacity-70"}`} />
                    <div className="font-medium">{o.asset.symbol}</div>
                    <div className="text-[12px] text-dim">
                      {issuerName(o.asset.issuer)} <span className="text-faint">vs</span> {fmtReferenceSource(o.referenceSource)}
                    </div>
                  </td>
                  <td className="num px-3 py-2.5 text-right">{fmtPrice(o.onChainPrice)}</td>
                  <td className="num px-3 py-2.5 text-right text-dim">{fmtPrice(o.referencePrice)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <div className="w-[84px] shrink-0">
                        <GapBar spreadPercent={o.spreadPercent} scale={scale} muted={dim} />
                      </div>
                      <SpreadFigure spreadPercent={o.spreadPercent} className="text-[13px]" />
                    </div>
                  </td>
                  <td className="num px-3 py-2.5 text-right text-dim">
                    {fmtAgeHours(o.referenceAgeHours)}
                    {o.referencePotentiallyStale && <span className="ml-1 text-act" title="Reference may be stale">•</span>}
                  </td>
                  <td className="num px-3 py-2.5 text-right">{fmtCompactUsd(o.liquidityUsd)}</td>
                  <td className="px-3 py-2.5 text-right"><NetFigure o={o} /></td>
                  <td className="px-3 py-2.5"><ConfidenceMeter level={o.confidence} score={o.confidenceScore} /></td>
                  <td className="py-2.5 pl-3 pr-4 lg:pr-6"><ActionBadge action={o.action} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* < md: list */}
      <ul className="divide-y divide-rule md:hidden" aria-label="Opportunities, strongest first">
        {rows.map((o) => (
          <li key={o.asset.address}>
            <button
              type="button"
              onClick={() => onSelect(o.asset.address)}
              className={`relative grid w-full grid-cols-[1fr_auto] gap-x-3 gap-y-2 px-4 py-3 text-left active:bg-raised ${
                selected === o.asset.address ? "bg-raised" : ""
              }`}
            >
              <span aria-hidden className={`absolute inset-y-2 left-0 w-[3px] ${ACTION_STYLE[o.action].bar}`} />
              <span>
                <span className="font-medium">{o.asset.symbol}</span>
                <span className="ml-1.5 text-[12px] text-dim">{issuerName(o.asset.issuer)}</span>
              </span>
              <ActionBadge action={o.action} />
              <span className="flex items-center gap-2.5">
                <span className="w-16"><GapBar spreadPercent={o.spreadPercent} scale={scale} muted={o.action === "IGNORE"} /></span>
                <SpreadFigure spreadPercent={o.spreadPercent} className="text-[13px]" />
              </span>
              <span className="text-right text-[12px] text-dim">
                Net <NetFigure o={o} />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
