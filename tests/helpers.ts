import { vi } from "vitest";
import { BinanceHttpClient, type HttpClientConfig } from "../src/lib/binance/http";
import { BinanceWeb3Client } from "../src/lib/binance/facade";

export const TEST_KEY = "test-api-key-1234567890";
export const TEST_SECRET = "test-api-secret-abcdefghij";
export const FIXED_NOW = new Date("2026-10-08T12:00:00.000Z");

export type Recorded = { url: string; init: RequestInit };
export type Responder = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** Fake fetch: no network. Responders are consumed in order, or routed by a function. */
export function fakeFetch(responders: Responder[] | Responder) {
  const calls: Recorded[] = [];
  const queue = Array.isArray(responders) ? [...responders] : undefined;
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url: url.toString(), init: init ?? {} });
    const r = queue ? queue.shift() : (responders as Responder);
    if (!r) throw new Error(`unexpected request to ${url}`);
    return r(url, init ?? {});
  });
  return { impl: impl as unknown as typeof fetch, calls, mock: impl };
}

export const envelope = (data: unknown, extra: Record<string, unknown> = {}) => ({
  code: 0,
  msg: "success",
  data,
  timestamp: FIXED_NOW.getTime(),
  success: true,
  ...extra,
});

export const json =
  (status: number, body: unknown, headers: Record<string, string> = {}): Responder =>
  () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function httpClient(fetchImpl: typeof fetch, extra: Partial<HttpClientConfig> = {}) {
  return new BinanceHttpClient({
    apiKey: TEST_KEY,
    apiSecret: TEST_SECRET,
    baseUrl: "https://web3.binance.com/build",
    recvWindowMs: 5000,
    timeoutMs: 1000,
    fetchImpl,
    now: () => FIXED_NOW,
    sleep: async () => {},
    ...extra,
  });
}

export function apiClient(fetchImpl: typeof fetch, extra: Partial<HttpClientConfig> = {}) {
  return new BinanceWeb3Client(httpClient(fetchImpl, extra));
}

/** Valid-format BSC addresses for tests. These are NOT real token addresses. */
export const ADDR = {
  a: "0x1111111111111111111111111111111111111111",
  b: "0x2222222222222222222222222222222222222222",
  wallet: "0x3333333333333333333333333333333333333333",
  quote: "0x4444444444444444444444444444444444444444",
};
