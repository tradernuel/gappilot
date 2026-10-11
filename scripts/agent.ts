/**
 * GapPilot local agent worker.
 *
 *   npm run agent -- init --from gappilot-export.json --provider mock|binance-agentic-wallet \
 *        --max-trade 25 --trades-per-day 3 --daily 75 --hours 24 [--out agent-bundle.json]
 *   npm run agent -- run --bundle agent-bundle.json [--live] [--wallet 0x...] [--interval 60] [--audit audit/agent-audit.jsonl]
 *
 * `init` creates an autonomous grant bound to the exported strategy (the
 * per-trade limit can't exceed the strategy's) and writes a bundle.
 *
 * `run` executes cycles: scan → strategy → agent → quote → build → Transaction
 * API simulation → authorization → provider → hash-chained audit record.
 *
 * LIVE execution requires ALL of: grant provider "binance-agentic-wallet",
 * GAPPILOT_EXECUTION_ENABLED=true, the --live flag, and a signed-in `baw`
 * session on this machine. Otherwise the mock provider runs (SIMULATED).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { BinanceWeb3Client } from "../src/lib/binance/facade";
import { UserRulesSchema } from "../src/lib/agent/types";
import { StrategySchema } from "../src/lib/strategy/schema";
import { AutonomyGrantSchema, type ExecutionProvider } from "../src/lib/execution/types";
import { createGrant, strategyHash } from "../src/lib/execution/policy";
import { JsonlFileAuditLog, verifyChain } from "../src/lib/execution/audit";
import { MockExecutionProvider } from "../src/lib/execution/mock-provider";
import { BinanceAgenticWalletProvider, nodeCliRunner } from "../src/lib/execution/agentic-provider";
import { runAutonomousCycle } from "../src/lib/execution/runner";
import { createLogger, type LogLevel } from "../src/lib/logging/logger";

const ExportSchema = z.object({ v: z.literal(1), strategy: StrategySchema, strategyName: z.string().min(1).max(120), rules: UserRulesSchema }).strict();
const BundleSchema = z.object({ v: z.literal(1), grant: AutonomyGrantSchema, strategy: StrategySchema, strategyName: z.string(), rules: UserRulesSchema }).strict();

const [command, ...rest] = process.argv.slice(2);
const opt = (n: string) => (rest.includes(`--${n}`) ? rest[rest.indexOf(`--${n}`) + 1] : undefined);
const flag = (n: string) => rest.includes(`--${n}`);
const die = (msg: string): never => {
  console.error(`✘ ${msg}`);
  process.exit(1);
};
const need = (n: string) => process.env[n] ?? die(`Missing ${n} (see .env.example).`);

function init() {
  const from = opt("from") ?? die("--from <export.json> is required (export it from the Autonomy view).");
  const exp = ExportSchema.safeParse(JSON.parse(readFileSync(from, "utf8")));
  if (!exp.success) die(`Invalid export: ${exp.error!.issues.map((i) => i.message).join("; ")}`);
  const provider = (opt("provider") ?? "mock") as "mock" | "binance-agentic-wallet";
  if (!["mock", "binance-agentic-wallet"].includes(provider)) die("--provider must be mock or binance-agentic-wallet");
  const created = createGrant({
    strategy: exp.data!.strategy,
    strategyName: exp.data!.strategyName,
    maxTradeUsd: Number(opt("max-trade") ?? exp.data!.strategy.maximumTradeUsd),
    maxTradesPerDay: Number(opt("trades-per-day") ?? 3),
    maxDailyUsd: Number(opt("daily") ?? exp.data!.strategy.maximumTradeUsd * 3),
    durationMs: Number(opt("hours") ?? 24) * 3_600_000,
    provider,
    now: Date.now(),
  });
  if (!created.ok) return die(created.message);
  const out = opt("out") ?? "agent-bundle.json";
  writeFileSync(out, JSON.stringify({ v: 1, grant: created.grant, strategy: exp.data!.strategy, strategyName: exp.data!.strategyName, rules: exp.data!.rules }, null, 2));
  console.log(`✔ Grant ${created.grant.grantId} for "${exp.data!.strategyName}" (${provider}) written to ${out}. Expires ${new Date(created.grant.expiresAt).toISOString()}.`);
}

async function run() {
  const bundlePath = opt("bundle") ?? die("--bundle <agent-bundle.json> is required (create it with `init`).");
  const parsed = BundleSchema.safeParse(JSON.parse(readFileSync(bundlePath, "utf8")));
  if (!parsed.success) die(`Invalid bundle: ${parsed.error!.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const b = parsed.data!;
  if (strategyHash(b.strategy) !== b.grant.strategyHash) die("The bundle's strategy doesn't match its grant. Re-run init.");

  const apiKey = need("BINANCE_WEB3_API_KEY");
  const apiSecret = need("BINANCE_WEB3_API_SECRET");
  const logger = createLogger({ level: (process.env.LOG_LEVEL as LogLevel) ?? "warn", secrets: [apiKey, apiSecret], bindings: { service: "gappilot-agent" } });
  const client = BinanceWeb3Client.create({
    apiKey,
    apiSecret,
    baseUrl: process.env.BINANCE_WEB3_BASE_URL ?? "https://web3.binance.com/build",
    recvWindowMs: Number(process.env.BINANCE_WEB3_RECV_WINDOW_MS ?? 5000),
    timeoutMs: Number(process.env.BINANCE_WEB3_TIMEOUT_MS ?? 10000),
    logger,
  });

  const wantsLive = b.grant.provider === "binance-agentic-wallet";
  const live = wantsLive && flag("live") && process.env.GAPPILOT_EXECUTION_ENABLED === "true";
  let provider: ExecutionProvider;
  if (live) {
    provider = new BinanceAgenticWalletProvider({
      run: nodeCliRunner(process.env.GAPPILOT_AGENTIC_CLI_PATH ?? "baw"),
      versionPrefix: process.env.GAPPILOT_AGENTIC_CLI_VERSION_PREFIX ?? "1.10.",
      isServerless: !!process.env.VERCEL,
    });
  } else {
    if (wantsLive) console.log("ℹ This grant allows the Agentic Wallet, but LIVE needs --live and GAPPILOT_EXECUTION_ENABLED=true. Running SIMULATED.");
    const wallet = opt("wallet") ?? die("--wallet <0x...> is required in simulated mode (the wallet whose balances are checked).");
    provider = new MockExecutionProvider({ wallet });
  }

  const auditPath = opt("audit") ?? "audit/agent-audit.jsonl";
  const audit = new JsonlFileAuditLog(auditPath);
  console.log(
    live
      ? "\n████  LIVE EXECUTION — Binance Agentic Wallet — real orders may be placed  ████\n"
      : "\n────  SIMULATED EXECUTION — MockExecutionProvider — nothing is sent  ────\n",
  );
  console.log(`Strategy: ${b.strategyName}  |  max $${b.grant.maxTradeUsd}/trade, ${b.grant.maxTradesPerDay}/day, $${b.grant.maxDailyUsd}/day  |  audit: ${auditPath}\n`);

  const cycle = async () => {
    const r = await runAutonomousCycle({
      client,
      provider,
      grant: b.grant,
      strategy: b.strategy,
      strategyName: b.strategyName,
      rules: b.rules,
      quoteTokenAddress: need("GAPPILOT_QUOTE_TOKEN_ADDRESS"),
      audit,
    });
    console.log(`[${new Date().toISOString()}] scanned ${r.scanned}, candidates ${r.candidates.length}: ${r.note}`);
    for (const rec of r.records) {
      console.log(`  ${rec.mode} ${rec.result} ${rec.asset?.symbol ?? ""} tx=${rec.execution.txHash ?? "—"}${rec.authorization.violations.length ? `  refused: ${rec.authorization.violations.map((v) => v.code).join(", ")}` : ""}`);
    }
  };

  const interval = opt("interval");
  if (!interval) return cycle();
  const ms = Math.max(30, Number(interval)) * 1000;
  for (;;) {
    try {
      await cycle();
    } catch (e) {
      console.error(`cycle failed: ${e instanceof Error ? e.message : e}`);
    }
    if (Date.now() > b.grant.expiresAt) return console.log("Grant expired; stopping.");
    await new Promise((res) => setTimeout(res, ms));
  }
}

function verify() {
  const path = opt("audit") ?? "audit/agent-audit.jsonl";
  if (!existsSync(path)) {
    console.log(`No audit log at ${path} yet (no execution has been attempted).`);
    process.exit(0);
  }
  const records = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const v = verifyChain(records);
  console.log(v.valid ? `✔ ${records.length} audit records, hash chain intact.` : `✘ Hash chain broken at record ${v.brokenAt}.`);
  process.exit(v.valid ? 0 : 1);
}

async function main() {
  if (command === "init") return init();
  if (command === "run") return run();
  if (command === "verify-audit") return verify();
  die("Usage: npm run agent -- <init|run|verify-audit> [options]");
}
main().catch((e) => die(e instanceof Error ? e.message : String(e)));
