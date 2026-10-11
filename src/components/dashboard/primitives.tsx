"use client";

import type { ConfidenceLevel, OpportunityAction } from "@/lib/engine/types";

export const ACTION_STYLE: Record<OpportunityAction, { label: string; text: string; bg: string; bar: string; hint: string }> = {
  EXECUTABLE: {
    label: "Executable",
    text: "text-exec",
    bg: "bg-exec/12 ring-exec/40",
    bar: "bg-exec",
    hint: "Passes every check, including your wallet. Simulate before trading.",
  },
  ACTIONABLE: {
    label: "Actionable",
    text: "text-act",
    bg: "bg-act/12 ring-act/40",
    bar: "bg-act",
    hint: "Market-side checks pass, but this wallet can't execute it as evaluated.",
  },
  WATCH: {
    label: "Watch",
    text: "text-watch",
    bg: "bg-watch/10 ring-watch/35",
    bar: "bg-watch",
    hint: "A real gap, but costs, liquidity or pricing don't support acting.",
  },
  IGNORE: {
    label: "Ignore",
    text: "text-ignore",
    bg: "bg-ignore/10 ring-ignore/30",
    bar: "bg-ignore",
    hint: "Not treated as an opportunity.",
  },
};

export function ActionBadge({ action, size = "sm" }: { action: OpportunityAction; size?: "sm" | "md" }) {
  const s = ACTION_STYLE[action];
  return (
    <span
      title={s.hint}
      className={`inline-flex items-center gap-1.5 rounded-[3px] ring-1 ring-inset font-medium ${s.bg} ${s.text} ${
        size === "md" ? "px-2.5 py-1 text-[13px]" : "px-2 py-0.5 text-[12px]"
      }`}
    >
      <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${s.bar}`} />
      {s.label}
    </span>
  );
}

const CONF_SEGMENTS: Record<ConfidenceLevel, number> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
const CONF_LABEL: Record<ConfidenceLevel, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High" };

export function ConfidenceMeter({ level, score }: { level: ConfidenceLevel; score?: number }) {
  const n = CONF_SEGMENTS[level];
  return (
    <span className="inline-flex items-center gap-2" title={score !== undefined ? `Confidence score ${score.toFixed(2)}` : undefined}>
      <span aria-hidden className="flex gap-[2px]">
        {[1, 2, 3].map((i) => (
          <span key={i} className={`h-2.5 w-1 rounded-[1px] ${i <= n ? "bg-text/80" : "bg-rule-strong"}`} />
        ))}
      </span>
      <span className="text-[13px] text-dim">{CONF_LABEL[level]}</span>
    </span>
  );
}

/**
 * The gap itself: a diverging bar from the reference midline.
 * Premium extends right (copper), discount extends left (sky).
 * `scale` is the |spread| that fills one half; bars clamp at the edge.
 */
export function GapBar({ spreadPercent, scale, muted }: { spreadPercent: number; scale: number; muted?: boolean }) {
  const frac = Math.min(1, Math.abs(spreadPercent) / Math.max(scale, 0.0001));
  const premium = spreadPercent > 0;
  const width = `${(frac * 50).toFixed(2)}%`;
  return (
    <span aria-hidden className="relative block h-3 w-full">
      <span className="absolute inset-y-1.5 left-0 right-0 h-px bg-rule-strong" />
      <span className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-dim/70" />
      {spreadPercent !== 0 && (
        <span
          className={`absolute top-[3px] h-1.5 rounded-[1px] ${premium ? "bg-premium" : "bg-discount"} ${muted ? "opacity-40" : ""}`}
          style={premium ? { left: "50%", width } : { right: "50%", width }}
        />
      )}
    </span>
  );
}

export function SpreadFigure({ spreadPercent, className = "" }: { spreadPercent: number; className?: string }) {
  const tone = spreadPercent > 0 ? "text-premium" : spreadPercent < 0 ? "text-discount" : "text-dim";
  const glyph = spreadPercent > 0 ? "▲" : spreadPercent < 0 ? "▼" : "";
  const label = spreadPercent > 0 ? "premium" : spreadPercent < 0 ? "discount" : "no difference";
  return (
    <span className={`num ${tone} ${className}`} aria-label={`${Math.abs(spreadPercent).toFixed(2)} percent ${label}`}>
      <span aria-hidden className="mr-1 text-[9px] align-[1px]">{glyph}</span>
      {spreadPercent > 0 ? "+" : spreadPercent < 0 ? "−" : ""}
      {Math.abs(spreadPercent).toFixed(2)}%
    </span>
  );
}

export function LogoMark({ className = "" }: { className?: string }) {
  // Two offset bars with a gap between them: the price and its reference.
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className}>
      <rect x="3" y="6" width="12" height="4" rx="1" fill="#f0a73a" />
      <rect x="9" y="14" width="12" height="4" rx="1" fill="#dce3ea" />
      <rect x="15.5" y="6" width="1.5" height="12" fill="#f0a73a" opacity="0.55" />
    </svg>
  );
}
