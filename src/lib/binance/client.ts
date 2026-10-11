import "server-only";
import { getServerEnv, type ServerEnv } from "../config/env";
import { getLogger } from "../logging/server-logger";
import { BinanceWeb3Client } from "./facade";
import type { HttpClientConfig } from "./http";

export function createBinanceClientFromEnv(
  env: ServerEnv = getServerEnv(),
  overrides: Partial<HttpClientConfig> = {},
): BinanceWeb3Client {
  return BinanceWeb3Client.create({
    apiKey: env.BINANCE_WEB3_API_KEY,
    apiSecret: env.BINANCE_WEB3_API_SECRET,
    baseUrl: env.BINANCE_WEB3_BASE_URL,
    recvWindowMs: env.BINANCE_WEB3_RECV_WINDOW_MS,
    timeoutMs: env.BINANCE_WEB3_TIMEOUT_MS,
    logger: getLogger(),
    ...overrides,
  });
}

let singleton: BinanceWeb3Client | undefined;

/** Lazily-created shared client for route handlers (server-only; holds the API secret). */
export function getBinanceClient(): BinanceWeb3Client {
  singleton ??= createBinanceClientFromEnv();
  return singleton;
}
