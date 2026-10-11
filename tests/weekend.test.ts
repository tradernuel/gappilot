import { describe, expect, it } from "vitest";
import { deriveWeekendState, formatCountdown } from "../src/lib/client/weekend";
import type { Opportunity } from "../src/lib/engine/types";

const NOW = 1_800_000_000_000;
const status = (over: Partial<Opportunity["marketStatus"]> = {}) => ({
  available: true, openState: false, marketStatus: "closed", reasonCode: "MARKET_CLOSED", reasonMsg: "Weekend or Holiday",
  nextOpenTime: NOW + 38 * 3_600_000, nextCloseTime: null, isHardBlocked: false, ...over,
});
const o = (action: Opportunity["action"], spread: number, ms = status()) => ({ action, spreadPercent: spread, marketStatus: ms }) as unknown as Opportunity;

describe("deriveWeekendState", () => {
  it("is ACTIVE when the scan reports the market closed, with figures from the scan", () => {
    const w = deriveWeekendState({
      assetsDiscovered: 17,
      opportunities: [o("EXECUTABLE", 1), o("ACTIONABLE", -2), o("WATCH", 3), o("IGNORE", 0.1), o("IGNORE", -0.1)],
    });
    expect(w).toMatchObject({
      status: "ACTIVE", marketLabel: "CLOSED", reason: "Weekend or Holiday", nextOpenTime: NOW + 38 * 3_600_000,
      monitoring: 17, compared: 5, opportunities: 3, actionable: 2, executable: 1,
    });
  });

  it("is STANDBY when the market is open, and has no next-open time", () => {
    const open = status({ openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null });
    expect(deriveWeekendState({ assetsDiscovered: 4, opportunities: [o("WATCH", 1, open)] })).toMatchObject({ status: "STANDBY", marketLabel: "OPEN", nextOpenTime: null });
  });

  it("is UNKNOWN before a scan, or when market status isn't reported", () => {
    expect(deriveWeekendState(null)).toMatchObject({ status: "UNKNOWN", monitoring: null, opportunities: 0 });
    expect(deriveWeekendState({ opportunities: [o("WATCH", 1, status({ available: false }))] }).status).toBe("UNKNOWN");
  });

  it("never invents a monitoring count", () => {
    expect(deriveWeekendState({ opportunities: [o("WATCH", 1)] }).monitoring).toBeNull();
  });

  it("counts restricted tokens", () => {
    expect(deriveWeekendState({ opportunities: [o("IGNORE", 1, status({ isHardBlocked: true }))] }).restricted).toBe(1);
  });
});

describe("formatCountdown", () => {
  it("formats days, hours and minutes", () => {
    expect(formatCountdown(NOW + (38 * 60 + 22) * 60_000, NOW)).toBe("1d 14h 22m");
    expect(formatCountdown(NOW + 185 * 60_000, NOW)).toBe("3h 05m");
    expect(formatCountdown(NOW + 12 * 60_000 + 30_000, NOW)).toBe("12m");
  });
  it("returns null for past or unknown times", () => {
    expect(formatCountdown(NOW - 1, NOW)).toBeNull();
    expect(formatCountdown(null, NOW)).toBeNull();
  });
});
