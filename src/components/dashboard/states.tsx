"use client";

import type { ReactNode } from "react";

export function TableSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading opportunities" className="divide-y divide-rule">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="grid grid-cols-[1.4fr_repeat(3,1fr)] gap-4 px-4 py-3.5 lg:grid-cols-[1.6fr_repeat(8,1fr)]">
          <div className="space-y-1.5">
            <div className="skeleton h-3.5 w-20" />
            <div className="skeleton h-2.5 w-28" />
          </div>
          {Array.from({ length: 8 }, (_, j) => (
            <div key={j} className={`skeleton h-3.5 self-center ${j > 2 ? "hidden lg:block" : ""}`} style={{ width: `${55 + ((i + j) % 4) * 10}%` }} />
          ))}
        </div>
      ))}
      <span className="sr-only">Scanning tokenized stocks on BNB Smart Chain…</span>
    </div>
  );
}

export function Notice({
  tone,
  title,
  children,
  action,
}: {
  tone: "error" | "neutral" | "warn";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const border = tone === "error" ? "border-danger/50" : tone === "warn" ? "border-act/50" : "border-rule-strong";
  const titleColor = tone === "error" ? "text-danger" : tone === "warn" ? "text-act" : "text-text";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`mx-auto my-10 max-w-xl border-l-2 ${border} bg-panel px-5 py-4`}>
      <p className={`font-medium ${titleColor}`}>{title}</p>
      {children && <div className="mt-1.5 text-[13px] leading-relaxed text-dim">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "secondary",
  disabled,
  type = "button",
  className = "",
  ...rest
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  className?: string;
  "aria-label"?: string;
  title?: string;
}) {
  const styles = {
    primary: "bg-brand text-ink hover:bg-brand/90 font-medium",
    secondary: "border border-rule-strong text-text hover:border-dim hover:bg-raised",
    ghost: "text-dim hover:text-text hover:bg-raised",
  }[variant];
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[3px] px-3 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
