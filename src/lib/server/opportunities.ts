import "server-only";
import { z } from "zod";
import { getBinanceClient } from "../binance/client";
import { getServerEnv } from "../config/env";
import { OpportunityScanner, type ScanResult } from "../engine/scanner";
import { attest } from "../assessment/attestation";
import { evmAddress } from "../binance/validation";

export const ScanQuery = z.object({
  notional: z.coerce.number().positive().max(1_000_000).default(100),
  wallet: evmAddress.optional(),
  maxPairs: z.coerce.number().int().min(1).max(25).default(10),
});
export type ScanQuery = z.infer<typeof ScanQuery>;

export interface DashboardScan extends ScanResult {
  /** HMAC per opportunity address, over JSON.stringify(opportunity). */
  attestations: Record<string, string>;
  cachedAt: number;
}

const TTL_MS = 15_000;
const cache = new Map<string, { at: number; value: DashboardScan }>();
const inflight = new Map<string, Promise<DashboardScan>>();

/** Scan with a 15 s per-query cache and in-flight de-duplication. */
export async function scanForDashboard(q: ScanQuery): Promise<DashboardScan> {
  const key = `${q.notional}|${q.maxPairs}|${q.wallet?.toLowerCase() ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async () => {
    const env = getServerEnv();
    const result = await new OpportunityScanner(getBinanceClient()).scan({
      notional: q.notional,
      wallet: q.wallet,
      maxPairs: q.maxPairs,
      quoteTokenAddress: env.GAPPILOT_QUOTE_TOKEN_ADDRESS,
      policy: {
        minNetEdgeBps: env.GAPPILOT_MIN_NET_EDGE_BPS,
        minLiquidityUsd: env.GAPPILOT_MIN_LIQUIDITY_USD,
        maxPriceAgeMs: env.GAPPILOT_MAX_TOKEN_PRICE_AGE_MS,
      },
    });
    const attestations: Record<string, string> = {};
    for (const o of result.opportunities) {
      attestations[o.asset.address] = attest(JSON.stringify(o), env.BINANCE_WEB3_API_SECRET);
    }
    const value: DashboardScan = { ...result, attestations, cachedAt: Date.now() };
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    return value;
  })();
  inflight.set(key, task);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}
