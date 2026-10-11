"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { Opportunity } from "@/lib/engine/types";
import {
  fmtAgeHours,
  fmtAgeSeconds,
  fmtPct,
  fmtPrice,
  fmtReferenceSource,
  fmtTokenAmount,
  fmtUsd,
  fmtWhen,
  issuerName,
} from "@/lib/client/format";
import { ActionBadge, ConfidenceMeter, SpreadFigure } from "./primitives";
import { AgentPanel } from "./AgentPanel";
import type { UserRules } from "@/lib/agent/types";
import type { SavedStrategy } from "@/lib/strategy/schema";

const GATE_LABEL: Record<string, string> = {
  DATA: "Data",
  REFERENCE: "Independent reference",
  MARKET_STATUS: "Market status",
  SPREAD: "Spread above noise",
  FRESHNESS: "Fresh prices",
  LIQUIDITY: "Liquidity",
  COSTS: "Net of costs",
  TOKEN_SAFETY: "Token safety",
  QUOTE: "Executable quote",
  WALLET: "Wallet can execute",
  SIMULATION: "Simulation",
};

function Metric({ label, children, note }: { label: string; children: ReactNode; note?: ReactNode }) {
  return (
    <div className="min-w-0 bg-panel px-4 py-2.5 sm:px-5">
      <dt className="text-[12px] text-dim">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
      {note && <dd className="mt-0.5 text-[12px] text-dim">{note}</dd>}
    </div>
  );
}

function marketText(o: Opportunity): { main: string; note: string | null; tone: string } {
  const m = o.marketStatus;
  if (!m.available) return { main: "Unavailable", note: "Not reported by the API", tone: "text-dim" };
  if (m.isHardBlocked) return { main: "Restricted", note: [m.reasonCode, m.reasonMsg].filter(Boolean).join(": "), tone: "text-danger" };
  if (m.openState) return { main: "Open", note: m.marketStatus ? `Session: ${m.marketStatus}` : null, tone: "text-exec" };
  return {
    main: "Closed",
    note: [m.reasonMsg, m.nextOpenTime ? `opens ${fmtWhen(m.nextOpenTime)}` : null].filter(Boolean).join(", ") || null,
    tone: "text-act",
  };
}

function walletText(o: Opportunity): { main: string; note: string } {
  const w = o.walletPosition;
  if (!w.connected) return { main: "Not connected", note: "Connect a wallet to check whether you can act on this." };
  if (o.direction === "PREMIUM") {
    return {
      main: `${fmtTokenAmount(w.tokenBalance, o.asset.symbol)}${w.tokenBalanceUsd !== null ? ` (${fmtUsd(w.tokenBalanceUsd)})` : ""}`,
      note: w.canSellNotional
        ? `Enough to sell the evaluated ${fmtUsd(o.notional, 0)}.`
        : w.tokenBalance
          ? `Less than the evaluated ${fmtUsd(o.notional, 0)}.`
          : "A premium can only be acted on by selling tokens you hold.",
    };
  }
  return {
    main: `${w.stableBalance !== null ? w.stableBalance.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "—"} stablecoin`,
    note: w.canBuyNotional ? `Enough to buy the evaluated ${fmtUsd(o.notional, 0)}.` : `Not enough to buy the evaluated ${fmtUsd(o.notional, 0)}.`,
  };
}

export function DetailPanel({
  opportunity: o,
  attestation,
  rules,
  walletAddress,
  strategies,
  onClose,
}: {
  opportunity: Opportunity;
  attestation: string | undefined;
  rules: UserRules;
  walletAddress: string | null;
  strategies: SavedStrategy[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [o.asset.address]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const market = marketText(o);
  const wallet = walletText(o);
  const [lead, ...rest] = o.reasons;

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="false"
      aria-labelledby="detail-title"
      className="panel-enter flex h-full flex-col outline-none"
    >
      <div className="flex items-start gap-3 border-b border-rule px-5 py-4">
        <div className="min-w-0 flex-1">
          <h2 id="detail-title" className="text-[19px] font-semibold tracking-tight">
            {o.asset.symbol} <span className="text-[14px] font-normal text-dim">{issuerName(o.asset.issuer)}</span>
          </h2>
          <p className="mt-0.5 text-[12px] text-dim">
            {o.asset.underlyingTicker} per share, compared with {fmtReferenceSource(o.referenceSource)} at {fmtUsd(o.notional, 0)} size
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-3">
            <ActionBadge action={o.action} size="md" />
            <ConfidenceMeter level={o.confidence} score={o.confidenceScore} />
            <span className="text-[12px] text-dim">Score <span className="num text-text">{o.score}</span>/100</span>
          </div>
        </div>
        <button onClick={onClose} aria-label="Close details" className="-mr-1 rounded-[3px] p-1.5 text-dim hover:bg-raised hover:text-text">
          <svg aria-hidden viewBox="0 0 16 16" className="h-4 w-4"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto">
        <dl className="grid grid-cols-2 gap-px border-b border-rule bg-rule">
          <Metric label="On-chain price" note={`${fmtPrice(o.onChainTokenPrice)} per token, ${fmtAgeSeconds(o.onChainPriceAgeSeconds)} old`}>
            <span className="num text-[16px]">{fmtPrice(o.onChainPrice)}</span>
          </Metric>
          <Metric label="Reference price" note={o.referenceKind === "CROSS_ISSUER" ? "Other issuer, on-chain" : o.referenceKind === "EXTERNAL_OFFICIAL" ? "Official market price" : "Derived from this token"}>
            <span className="num text-[16px]">{fmtPrice(o.referencePrice)}</span>
          </Metric>
          <Metric label="Spread" note={<span className="num">{o.spreadUsd >= 0 ? "+" : "−"}{fmtPrice(o.absoluteSpreadUsd)} per share</span>}>
            <SpreadFigure spreadPercent={o.spreadPercent} className="text-[16px]" />
          </Metric>
          <Metric label="Reference age" note={o.referencePotentiallyStale ? <span className="text-act">Potentially stale: the market is closed</span> : undefined}>
            <span className="num text-[16px]">{fmtAgeHours(o.referenceAgeHours)}</span>
          </Metric>
          <Metric label="Market status" note={market.note}>
            <span className={`text-[16px] ${market.tone}`}>{market.main}</span>
          </Metric>
          <Metric label="Liquidity" note="Summed DEX pool liquidity">
            <span className="num text-[16px]">{fmtUsd(o.liquidityUsd, 0)}</span>
          </Metric>
          <Metric label="Estimated slippage" note={o.estimatedSlippagePercent === null ? "Needs an executable quote" : "Quote vs on-chain mid"}>
            <span className="num text-[16px]">{fmtPct(o.estimatedSlippagePercent)}</span>
          </Metric>
          <Metric label="Estimated gas" note={o.estimatedTaxPercent ? `Plus ${fmtPct(o.estimatedTaxPercent)} token tax` : undefined}>
            <span className="num text-[16px]">{fmtUsd(o.estimatedGasUsd, o.estimatedGasUsd !== null && o.estimatedGasUsd < 1 ? 4 : 2)}</span>
          </Metric>
          <Metric label="Net opportunity" note={o.totalCostPercent !== null ? `After ${fmtPct(o.totalCostPercent)} estimated costs` : "Not estimated without a quote"}>
            <span className={`num text-[16px] ${o.netOpportunityPercent !== null && o.netOpportunityPercent > 0 ? "text-text" : "text-dim"}`}>
              {fmtPct(o.netOpportunityPercent, { signed: true })}
            </span>
          </Metric>
          <Metric label="Wallet position" note={wallet.note}>
            <span className="num text-[15px]">{wallet.main}</span>
          </Metric>
        </dl>

        <section aria-labelledby="why-heading" className="px-5 py-4">
          <h3 id="why-heading" className="font-medium">Why am I seeing this?</h3>
          {lead && <p className="mt-2 text-[13.5px] leading-relaxed">{lead}</p>}
          {rest.length > 0 && (
            <ul className="mt-2.5 space-y-1.5 text-[13px] leading-relaxed text-dim">
              {rest.map((r, i) => (
                <li key={i} className="flex gap-2">
                  <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-faint" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          )}
          <ul className="mt-3.5 flex flex-wrap gap-1.5" aria-label="Engine checks">
            {o.gates.map((g, i) => (
              <li
                key={`${g.gate}-${i}`}
                title={g.detail}
                className={`rounded-[3px] border px-1.5 py-0.5 text-[11.5px] ${g.passed ? "border-rule-strong text-dim" : "border-act/40 text-act"}`}
              >
                <span aria-hidden>{g.passed ? "✓" : "✕"}</span> {GATE_LABEL[g.gate] ?? g.gate}
                <span className="sr-only">{g.passed ? " passed" : " failed"}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-faint">Generated by GapPilot&apos;s rule-based engine. No AI is involved in these reasons.</p>
        </section>

        <AgentPanel opportunity={o} attestation={attestation} rules={rules} wallet={walletAddress} strategies={strategies} />

        <footer className="border-t border-rule px-5 py-4 text-[12px] leading-relaxed text-dim">
          <p>{o.disclaimer}</p>
          <p className="mt-1.5">Trades need a passed simulation and your explicit approval. This web app executes in simulation only; live execution runs only in the local agent.</p>
        </footer>
      </div>
    </div>
  );
}
