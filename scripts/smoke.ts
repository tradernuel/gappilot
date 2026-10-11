/**
 * Live smoke test against the real Binance Web3 API. READ-ONLY.
 *
 *   npm run smoke                              # RWA + Market + Transaction(gas)
 *   npm run smoke -- --wallet 0xYourWallet     # + Wallet, Trading quote/approve, Transaction simulate
 *   npm run smoke -- --only rwa                # one module: rwa | market | wallet | trading | transaction
 *   npm run smoke -- --save                    # also write SANITIZED responses to fixtures/live/
 *
 * Nothing here signs a transaction, submits an order, or broadcasts.
 * Logs are structured JSON (LOG_LEVEL=debug for more) and are scrubbed of the API key/secret.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BinanceWeb3Client } from "../src/lib/binance/facade";
import { BinanceApiError } from "../src/lib/binance/errors";
import type { RwaToken } from "../src/lib/binance/types";
import { createLogger, createRedactor, type LogLevel } from "../src/lib/logging/logger";
import { priceRelationship, toMarketStatus } from "../src/lib/rwa/rwa-service";

const BSC = "56";
type Module = "rwa" | "market" | "wallet" | "trading" | "transaction";

// ── args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const wallet = option("wallet") ?? args.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
const only = option("only") as Module | undefined;
const save = flag("save");
const runs = (m: Module) => !only || only === m;

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing ${name}. Copy .env.example to .env.local and fill it in.`);
    process.exit(1);
  }
  return v;
}

const apiKey = required("BINANCE_WEB3_API_KEY");
const apiSecret = required("BINANCE_WEB3_API_SECRET");
const quoteToken = required("GAPPILOT_QUOTE_TOKEN_ADDRESS");

const logger = createLogger({
  level: (process.env.LOG_LEVEL as LogLevel | undefined) ?? "warn",
  secrets: [apiKey, apiSecret],
  bindings: { service: "gappilot-smoke" },
});

const client = BinanceWeb3Client.create({
  apiKey,
  apiSecret,
  baseUrl: process.env.BINANCE_WEB3_BASE_URL ?? "https://web3.binance.com/build",
  recvWindowMs: Number(process.env.BINANCE_WEB3_RECV_WINDOW_MS ?? 5000),
  timeoutMs: Number(process.env.BINANCE_WEB3_TIMEOUT_MS ?? 10000),
  logger,
});

// ── sanitizing fixture writer ────────────────────────────────────────────────
const { redact } = createRedactor([apiKey, apiSecret]);
const FIXTURE_DIR = path.join(process.cwd(), "fixtures", "live");

/** Replaces the user's wallet address everywhere, then applies log redaction. Truncates long arrays. */
function sanitize(value: unknown): unknown {
  let json = JSON.stringify(value ?? null);
  if (wallet) json = json.replace(new RegExp(wallet, "gi"), "0xYOUR_WALLET");
  const parsed = JSON.parse(json) as unknown;
  const trim = (v: unknown): unknown =>
    Array.isArray(v)
      ? [...v.slice(0, 3).map(trim), ...(v.length > 3 ? [`… ${v.length - 3} more items`] : [])]
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trim(x)]))
        : v;
  return redact(trim(parsed));
}

function saveFixture(name: string, payload: unknown) {
  if (!save) return;
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const file = path.join(FIXTURE_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify({ capturedAt: new Date().toISOString(), ...(payload as object) }, null, 2)}\n`);
}

// ── step runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function step<T>(name: string, fn: () => Promise<{ data: T; rateLimit: unknown }>): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const { data, rateLimit } = await fn();
    const ms = Date.now() - t0;
    passed++;
    const clean = sanitize(data);
    const preview = JSON.stringify(clean);
    console.log(`✔ ${name} (${ms} ms) rateLimit=${JSON.stringify(rateLimit)}`);
    console.log(`  ${preview.length > 500 ? `${preview.slice(0, 500)}…` : preview}\n`);
    saveFixture(name, { latencyMs: ms, rateLimit, data: clean });
    return data;
  } catch (err) {
    const ms = Date.now() - t0;
    failed++;
    console.log(`✘ ${name} (${ms} ms)`);
    if (err instanceof BinanceApiError) {
      console.log(`  kind=${err.kind} http=${err.httpStatus ?? "-"} code=${err.code ?? "-"}`);
      console.log(`  ${err.message}`);
      if (err.issues) console.log(`  issues=${JSON.stringify(err.issues)}`);
      if (err.bodySnippet) console.log(`  body=${String(sanitize(err.bodySnippet))}`);
      saveFixture(`${name}.error`, { latencyMs: ms, error: sanitize({ ...err.toJSON(), body: err.bodySnippet }) });
    } else {
      console.log(`  ${err instanceof Error ? err.message : String(err)}`);
    }
    console.log();
    return undefined;
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`GapPilot smoke test — ${new Date().toISOString()}`);
  console.log(`modules=${only ?? "all"} wallet=${wallet ? "provided" : "none"} save=${save}\n`);

  // Discovery is needed by most modules to pick a real token (never hardcoded).
  const bstocks = (await step("rwa.tokens.bstock", () => client.rwa.tokens({ binanceChainId: BSC, platformId: "bstock" }))) ?? [];
  const ondo = (await step("rwa.tokens.ondo", () => client.rwa.tokens({ binanceChainId: BSC, platformId: "ondo" }))) ?? [];
  console.log(`  BSC tokens: bstock=${bstocks.length} ondo=${ondo.length}\n`);

  const ondoByTicker = new Map(ondo.map((t: RwaToken) => [t.underlyingTicker, t]));
  const pair = bstocks.map((b) => [b, ondoByTicker.get(b.underlyingTicker)] as const).find(([, o]) => o);
  const sample: RwaToken | undefined = pair?.[0] ?? bstocks[0] ?? ondo[0];
  if (!sample?.tokenContractAddress) {
    console.log("No BSC RWA tokens returned; cannot continue.");
    process.exit(failed > 0 ? 1 : 0);
  }
  const address = sample.tokenContractAddress;
  const token = { binanceChainId: BSC, tokenContractAddress: address };
  console.log(
    pair
      ? `  cross-issuer pair: ${pair[0].underlyingTicker} → ${pair[0].tokenSymbol} (bstock) / ${pair[1]?.tokenSymbol} (ondo)\n`
      : `  no cross-issuer pair on BSC right now; sampling ${sample.tokenSymbol}\n`,
  );

  if (runs("rwa")) {
    await step("rwa.platforms", () => client.rwa.platforms());
    if (sample.underlyingTicker) await step("rwa.search", () => client.rwa.search({ keyword: sample.underlyingTicker! }));
    const addresses = [address, pair?.[1]?.tokenContractAddress].filter((a): a is string => !!a);
    const prices = await step("rwa.price", () => client.rwa.price({ binanceChainId: BSC, tokenContractAddresses: addresses }));
    const market = await step("rwa.underlyingMarket", () => client.rwa.underlyingMarket(token));
    const profile = await step("rwa.underlyingProfile", () => client.rwa.underlyingProfile(token));

    const rel = priceRelationship(prices?.[0], profile?.tokenToShareRatio ?? sample.tokenToShareRatio);
    console.log("  derived price relationship:", JSON.stringify(rel));
    console.log("  derived market status:", JSON.stringify(toMarketStatus(market?.statusInfo)), "\n");
    saveFixture("derived.priceRelationship", { data: rel });
  }

  let quoteDecimals: number | undefined;
  if (runs("market") || runs("trading")) {
    await step("market.topLiquidity", () => client.market.topLiquidity(token));
    const info = await step("market.basicInfo.quoteToken", () =>
      client.market.basicInfo({ binanceChainId: BSC, tokenContractAddress: quoteToken }));
    quoteDecimals = typeof info?.decimals === "number" ? info.decimals : undefined;
  }

  if (runs("transaction")) {
    await step("transaction.gasPrice", () => client.transaction.gasPrice(BSC));
  }

  if (!wallet) {
    console.log("Tip: add --wallet 0x... to test Wallet, Trading (quote/approve) and Transaction (simulate).");
  } else {
    if (runs("wallet")) {
      await step("wallet.allTokenBalances", () => client.wallet.allTokenBalances({ address: wallet, chains: BSC }));
      await step("wallet.tokenBalances", () =>
        client.wallet.tokenBalances({
          address: wallet,
          tokenContractAddresses: [
            { binanceChainId: BSC, tokenContractAddress: "" },
            { binanceChainId: BSC, tokenContractAddress: quoteToken },
            { binanceChainId: BSC, tokenContractAddress: address },
          ],
        }));
    }

    if ((runs("trading") || runs("transaction")) && quoteDecimals !== undefined) {
      const oneUnit = (10n ** BigInt(quoteDecimals)).toString(); // 1 quote token, from LIVE decimals
      const routes = await step("trading.quote", () =>
        client.trading.quote({
          binanceChainId: BSC,
          amount: oneUnit,
          fromTokenAddress: quoteToken,
          toTokenAddress: address,
          userWalletAddress: wallet,
        }));
      const best = routes?.find((r) => r.isBest) ?? routes?.[0];
      if (best) console.log(`  best route: vendor=${best.vendorName} mode=${best.executionMode} impact=${best.priceImpactPercent}\n`);

      if (best?.vendorName) {
        const approve = await step("trading.approveTransaction", () =>
          client.trading.approveTransaction({
            binanceChainId: BSC,
            tokenContractAddress: quoteToken,
            approveAmount: oneUnit,
            vendor: best.vendorName,
          }));
        const tx = approve?.[0];
        if (tx?.data && runs("transaction")) {
          await step("transaction.simulate.approve", () =>
            client.transaction.simulate({
              binanceChainId: BSC,
              evmTx: { from: wallet, to: quoteToken, value: "0", data: tx.data! },
            }));
        }
      }
    } else if (runs("trading")) {
      console.log("Skipping trading.quote: quote-token decimals unavailable from market.basicInfo.");
    }
  }

  console.log(`\nDone: ${passed} passed, ${failed} failed.${save ? ` Sanitized responses in ${FIXTURE_DIR}` : ""}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
