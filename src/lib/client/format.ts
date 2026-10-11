/** Display formatting. Pure; null/undefined render as an em dash so missing data is visible. */

const DASH = "—";
const ok = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

export function fmtPrice(n: number | null | undefined): string {
  if (!ok(n)) return DASH;
  const dp = Math.abs(n) >= 1 ? 2 : 4;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function fmtUsd(n: number | null | undefined, dp = 2): string {
  if (!ok(n)) return DASH;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

export function fmtCompactUsd(n: number | null | undefined): string {
  if (!ok(n)) return DASH;
  if (Math.abs(n) < 1_000) return `$${n.toFixed(0)}`;
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)}`;
}

export function fmtPct(n: number | null | undefined, opts: { signed?: boolean; dp?: number } = {}): string {
  if (!ok(n)) return DASH;
  const dp = opts.dp ?? 2;
  const s = `${Math.abs(n).toFixed(dp)}%`;
  if (!opts.signed) return n < 0 ? `−${s}` : s;
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export function fmtAgeSeconds(sec: number | null | undefined): string {
  if (!ok(sec)) return DASH;
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86_400) return `${(sec / 3600).toFixed(1)}h`;
  const d = Math.floor(sec / 86_400);
  return `${d}d ${Math.round((sec - d * 86_400) / 3600)}h`;
}

export const fmtAgeHours = (h: number | null | undefined) => (ok(h) ? fmtAgeSeconds(h * 3600) : DASH);

export function fmtTokenAmount(n: number | null | undefined, symbol: string): string {
  if (!ok(n)) return DASH;
  const dp = n === 0 ? 0 : n < 1 ? 6 : n < 1000 ? 4 : 2;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: dp })} ${symbol}`;
}

export function fmtClock(ms: number | null | undefined): string {
  if (!ok(ms)) return DASH;
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function fmtWhen(ms: number | null | undefined): string {
  if (!ok(ms)) return DASH;
  return new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

export const shortAddress = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function issuerName(issuer: string): string {
  return issuer === "bstock" ? "bStocks" : issuer === "ondo" ? "Ondo" : issuer === "xstocks" ? "xStocks" : issuer;
}

/** "bstock:XYZB" → "XYZB (bStocks)". */
export function fmtReferenceSource(source: string): string {
  const [issuer, symbol] = source.split(":");
  return symbol ? `${symbol} (${issuerName(issuer!)})` : source;
}
