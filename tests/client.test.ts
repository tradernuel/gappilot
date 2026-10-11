import { describe, expect, it } from "vitest";
import { createRateLimiter, clientKey } from "../src/lib/server/rate-limit";
import { summarize } from "../src/lib/client/summary";
import { fmtAgeSeconds, fmtCompactUsd, fmtPct, fmtPrice, fmtReferenceSource, fmtTokenAmount } from "../src/lib/client/format";
import { sanitizeSettings, DEFAULT_SETTINGS } from "../src/lib/client/use-settings";
import type { Opportunity } from "../src/lib/engine/types";

describe("rate limiter", () => {
  it("allows up to the limit per window, then reports retry-after", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 2, windowMs: 10_000, now: () => t });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a")).toEqual({ allowed: false, remaining: 0, retryAfterSec: 10 });
    expect(rl.check("b").allowed).toBe(true);
    t = 10_000;
    expect(rl.check("a").allowed).toBe(true);
  });
  it("keys on the first x-forwarded-for entry", () => {
    expect(clientKey(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }))).toBe("1.2.3.4");
  });
});

const o = (action: Opportunity["action"], spread: number, market: Partial<Opportunity["marketStatus"]> = {}) =>
  ({
    action,
    spreadPercent: spread,
    marketStatus: { available: true, openState: false, marketStatus: "closed", reasonCode: "MARKET_CLOSED", reasonMsg: "Weekend", nextOpenTime: null, nextCloseTime: null, isHardBlocked: false, ...market },
  }) as unknown as Opportunity;

describe("summarize", () => {
  it("counts detected without IGNORE, actionable as ACTIONABLE+EXECUTABLE, and averages |spread|", () => {
    const s = summarize([o("EXECUTABLE", 1), o("ACTIONABLE", -2), o("WATCH", 3), o("IGNORE", 0.1)]);
    expect(s).toMatchObject({ scanned: 4, detected: 3, actionable: 2, executable: 1, avgOver: 3 });
    expect(s.avgAbsSpread).toBeCloseTo(2);
    expect(s.market.tone).toBe("closed");
  });
  it("reports unknown market when no token has status", () => {
    expect(summarize([o("WATCH", 1, { available: false })]).market.tone).toBe("unknown");
  });
  it("handles an empty scan", () => {
    expect(summarize([])).toMatchObject({ scanned: 0, detected: 0, avgAbsSpread: null });
  });
});

describe("format", () => {
  it("renders missing values as an em dash", () => {
    for (const f of [fmtPrice, fmtCompactUsd, fmtPct, fmtAgeSeconds]) expect(f(null)).toBe("—");
  });
  it("formats prices, percents, ages and amounts", () => {
    expect(fmtPrice(187.4)).toBe("$187.40");
    expect(fmtPrice(0.12345)).toBe("$0.1235");
    expect(fmtPct(-0.97, { signed: true })).toBe("−0.97%");
    expect(fmtPct(0.5, { signed: true })).toBe("+0.50%");
    expect(fmtCompactUsd(2_400_000)).toBe("$2.4M");
    expect(fmtAgeSeconds(21)).toBe("21s");
    expect(fmtAgeSeconds(5400)).toBe("1.5h");
    expect(fmtAgeSeconds(90_000)).toBe("1d 1h");
    expect(fmtTokenAmount(12, "ACMEb")).toBe("12 ACMEb");
    expect(fmtReferenceSource("ondo:XYZon")).toBe("XYZon (Ondo)");
  });
});

describe("settings", () => {
  it("falls back to defaults for invalid stored values", () => {
    expect(sanitizeSettings({ notional: -5, maxPairs: 99, refreshSec: 15 as never })).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings({ notional: 250, maxPairs: 5, refreshSec: 30 })).toEqual({ notional: 250, maxPairs: 5, refreshSec: 30, rules: DEFAULT_SETTINGS.rules });
    expect(sanitizeSettings({ rules: { ...DEFAULT_SETTINGS.rules, maxSlippagePercent: 99 } }).rules).toEqual(DEFAULT_SETTINGS.rules);
  });
});
