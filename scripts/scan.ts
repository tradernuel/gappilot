/**
 * Live opportunity scan from the terminal. READ-ONLY.
 *
 *   npm run scan                                   # no wallet: prices, spreads, liquidity (≤ WATCH)
 *   npm run scan -- --wallet 0xYou --notional 250  # + quotes, balances, executability
 *   npm run scan -- --json                         # full Opportunity objects
 */
import { BinanceWeb3Client } from "../src/lib/binance/facade";
import { OpportunityScanner } from "../src/lib/engine/scanner";
import { createLogger, type LogLevel } from "../src/lib/logging/logger";

const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
const need = (n: string) => process.env[n] ?? (console.error(`Missing ${n} (see .env.example)`), process.exit(1));

const apiKey = need("BINANCE_WEB3_API_KEY");
const apiSecret = need("BINANCE_WEB3_API_SECRET");
const client = BinanceWeb3Client.create({
  apiKey,
  apiSecret,
  baseUrl: process.env.BINANCE_WEB3_BASE_URL ?? "https://web3.binance.com/build",
  recvWindowMs: Number(process.env.BINANCE_WEB3_RECV_WINDOW_MS ?? 5000),
  timeoutMs: Number(process.env.BINANCE_WEB3_TIMEOUT_MS ?? 10000),
  logger: createLogger({ level: (process.env.LOG_LEVEL as LogLevel) ?? "warn", secrets: [apiKey, apiSecret] }),
});

async function main() {
const result = await new OpportunityScanner(client).scan({
  notional: Number(opt("notional") ?? 100),
  wallet: opt("wallet"),
  maxPairs: Number(opt("max-pairs") ?? 10),
  quoteTokenAddress: need("GAPPILOT_QUOTE_TOKEN_ADDRESS"),
});

if (args.includes("--json")) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const f = (n: number | null, d = 2) => (n === null ? "—" : n.toFixed(d));
  console.log(`Signal: ${result.signal}  pairs: ${result.pairsScanned}/${result.pairsFound}  notional: ${result.notional}  wallet: ${result.walletConnected}\n`);
  console.table(
    result.opportunities.map((o) => ({
      token: `${o.asset.symbol} (${o.asset.issuer})`,
      "vs": o.referenceSource,
      "$/share": f(o.onChainPrice),
      "ref $/share": f(o.referencePrice),
      "spread %": f(o.spreadPercent),
      "slip %": f(o.estimatedSlippagePercent),
      "net %": f(o.netOpportunityPercent),
      "liq $": o.liquidityUsd === null ? "—" : Math.round(o.liquidityUsd),
      action: o.action,
      conf: o.confidence,
      score: o.score,
    })),
  );
  for (const o of result.opportunities.filter((x) => x.action !== "IGNORE")) {
    console.log(`\n${o.asset.symbol} → ${o.action}`);
    for (const r of o.reasons) console.log(`  • ${r}`);
  }
  if (result.errors.length) console.log("\nPartial errors:", result.errors);
  console.log(`\n${result.opportunities[0]?.disclaimer ?? ""}`);
}
}

main().catch((err) => {
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : err);
  process.exit(1);
});
