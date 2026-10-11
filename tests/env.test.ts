import { describe, expect, it } from "vitest";
import { getServerEnv, type EnvSource } from "../src/lib/config/env";

const base = {
  BINANCE_WEB3_API_KEY: "k",
  BINANCE_WEB3_API_SECRET: "s",
  GAPPILOT_QUOTE_TOKEN_ADDRESS: "0x55d398326f99059fF775485246999027B3197955",
} as EnvSource;

describe("getServerEnv", () => {
  it("applies safe defaults (execution off, /build base URL)", () => {
    const env = getServerEnv({ ...base });
    expect(env.GAPPILOT_EXECUTION_ENABLED).toBe(false);
    expect(env.BINANCE_WEB3_BASE_URL).toBe("https://web3.binance.com/build");
    expect(env.BINANCE_WEB3_RECV_WINDOW_MS).toBe(5000);
  });

  it("rejects missing secrets and bad addresses with a readable message", () => {
    expect(() => getServerEnv({ GAPPILOT_QUOTE_TOKEN_ADDRESS: "nope" } as EnvSource)).toThrow(
      /BINANCE_WEB3_API_KEY[\s\S]*GAPPILOT_QUOTE_TOKEN_ADDRESS/,
    );
  });

  it("caps recvWindow at the documented 60000 ms", () => {
    expect(() => getServerEnv({ ...base, BINANCE_WEB3_RECV_WINDOW_MS: "60001" })).toThrow();
  });
});

describe("getServerEnv (logging / routes)", () => {
  it("treats empty optional values from .env as unset", () => {
    const env = getServerEnv({ ...base, GAPPILOT_DEBUG_ROUTES_TOKEN: "", OPENAI_API_KEY: "" });
    expect(env.GAPPILOT_DEBUG_ROUTES_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rejects a short debug-routes token", () => {
    expect(() => getServerEnv({ ...base, GAPPILOT_DEBUG_ROUTES_TOKEN: "short" })).toThrow(/16/);
  });
});
