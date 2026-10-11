/**
 * VISUAL QA ONLY. Produces audit records with the REAL runner, policy and mock
 * provider against the fake Binance backend (fictional tokens). No LIVE records.
 */
import { writeFileSync } from "node:fs";
import { InMemoryAuditLog } from "../../src/lib/execution/audit";
import { MockExecutionProvider } from "../../src/lib/execution/mock-provider";
import { createGrant } from "../../src/lib/execution/policy";
import { runAutonomousCycle } from "../../src/lib/execution/runner";
import { DEFAULT_USER_RULES } from "../../src/lib/agent/types";
import { binanceBackend, USDT, WALLET } from "../fixtures/binance-backend";

const now = Date.now();
const strategy = { version: 1 as const, action: "BUY" as const, assetScope: { type: "ALL" as const }, spreadThresholdPercent: -0.75, minimumLiquidityUsd: 100_000, maximumTradeUsd: 50, maximumSlippagePercent: 0.5, marketStatus: "ANY" as const, requireSimulation: true as const, sourceText: "Buy tokenized stocks at least 0.75% below reference. Max $50 per trade." };
const g = createGrant({ strategy, strategyName: "Buy at 0.75% discount, max $50", maxTradeUsd: 25, maxTradesPerDay: 2, maxDailyUsd: 50, durationMs: 86_400_000, provider: "mock", now });
if (!g.ok) throw new Error(g.message);
const audit = new InMemoryAuditLog();
const { client } = binanceBackend({ now: () => Date.now() });
let t = now - 3 * 60_000;
for (let i = 0; i < 3; i++) {
  t += 60_000;
  await runAutonomousCycle({ client, provider: new MockExecutionProvider({ wallet: WALLET }), grant: g.grant, strategy, strategyName: "Buy at 0.75% discount, max $50", rules: DEFAULT_USER_RULES, quoteTokenAddress: USDT, audit, now: () => Date.now() });
}
const records = audit.list();
writeFileSync(process.argv[2] ?? "/tmp/audit-fixture.json", JSON.stringify({ records, strategy, saved: { id: "s1", name: "Buy at 0.75% discount, max $50", createdAt: now, strategy }, grant: g.grant }));
console.log(records.map((r) => `${r.mode} ${r.result} ${r.authorization.violations.map((v) => v.code).join(",")}`).join(" | "));
