/**
 * VISUAL QA ONLY. Generates a dashboard payload by running the REAL engine on
 * SYNTHETIC inputs with fictional tickers (ACME, GLOBEX, …). Used by the
 * screenshot harness to intercept /api/opportunities in the browser.
 * Never imported by application code.
 */
import { writeFileSync } from "node:fs";
import { evaluateOpportunity, rankOpportunities } from "../../src/lib/engine/evaluate";
import { numberToRawCeil } from "../../src/lib/engine/calculations";
import type { OpportunityInput, QuoteInput } from "../../src/lib/engine/types";
import type { MarketStatusView } from "../../src/lib/rwa/rwa-service";

const now = Date.now();
const E18 = 10n ** 18n;
const closed: MarketStatusView = {
  available: true, openState: false, marketStatus: "closed", reasonCode: "MARKET_CLOSED", reasonMsg: "Weekend or Holiday",
  nextOpenTime: now + 38 * 3_600_000, nextCloseTime: null, isHardBlocked: false,
};
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

function q(side: "BUY_TOKEN" | "SELL_TOKEN", tokenPrice: number, notional: number, slip: number, gas: number): QuoteInput {
  const stableRaw = BigInt(Math.round(notional * 1e6)) * 10n ** 12n;
  const tokens = numberToRawCeil(notional / tokenPrice, 18)!;
  const out = side === "SELL_TOKEN"
    ? BigInt(Math.round(notional * (1 - slip / 100) * 1e6)) * 10n ** 12n
    : numberToRawCeil((notional / tokenPrice) * (1 - slip / 100), 18)!;
  return {
    side, fromAmountRaw: (side === "SELL_TOKEN" ? tokens : stableRaw).toString(), fromDecimals: 18, toAmountRaw: out.toString(), toDecimals: 18,
    stableUnitPriceUsd: 1, priceImpactPercent: slip, tradeFeeUsd: gas, taxRate: 0, isHoneyPot: false,
    executionMode: "RFQ", vendorName: "PcsXRfq", quoteId: "fixture", fetchedAt: now - 4_000,
  };
}

let n = 1;
function leg(sym: string, issuer: string, ticker: string, price: number, ref: number, refSym: string, refIssuer: string, liq: number | null, over: Partial<OpportunityInput> = {}) {
  const notional = 250;
  const side = price > ref ? "SELL_TOKEN" : "BUY_TOKEN";
  return evaluateOpportunity({
    asset: { address: addr(n++), issuer, symbol: sym, underlyingTicker: ticker, decimals: 18, tokenToShareRatio: 1 },
    onChain: { tokenPriceUsd: price, updatedAt: now - 14_000 },
    reference: { kind: "CROSS_ISSUER", perSharePriceUsd: ref, asOf: now - 21_000, source: `${refIssuer}:${refSym}`, counterpart: { address: addr(900 + n), issuer: refIssuer, symbol: refSym } },
    market: closed,
    liquidity: liq === null ? null : { totalUsd: liq, poolCount: 3 },
    notional,
    quote: q(side, price, notional, 0.18, 0.04),
    wallet: { address: addr(7), tokenBalanceRaw: (sym === "ACMEb" ? 12n * E18 : 0n).toString(), tokenDecimals: 18, stableBalanceRaw: (180n * E18).toString(), stableDecimals: 18, fetchedAt: now },
    now,
    ...over,
  });
}

const opportunities = rankOpportunities([
  leg("ACMEb", "bstock", "ACME", 187.42, 185.61, "ACMEon", "ondo", 2_400_000),
  leg("ACMEon", "ondo", "ACME", 185.61, 187.42, "ACMEb", "bstock", 1_900_000),
  leg("GLBXb", "bstock", "GLBX", 412.1, 409.02, "GLBXon", "ondo", 860_000),
  leg("GLBXon", "ondo", "GLBX", 409.02, 412.1, "GLBXb", "bstock", 1_100_000),
  leg("INITb", "bstock", "INIT", 58.3, 58.24, "INITon", "ondo", 640_000),
  leg("INITon", "ondo", "INIT", 58.24, 58.3, "INITb", "bstock", 720_000),
  leg("UMBRb", "bstock", "UMBR", 23.95, 24.41, "UMBRon", "ondo", 18_000, { quote: null }),
  leg("UMBRon", "ondo", "UMBR", 24.41, 23.95, "UMBRb", "bstock", 41_000, { quote: null }),
  leg("SOYLb", "bstock", "SOYL", 131.2, 129.9, "SOYLon", "ondo", null, {
    market: { ...closed, reasonCode: "ASSET_PAUSED", reasonMsg: "stock_split", isHardBlocked: true }, quote: null,
  }),
]);

const attestations = Object.fromEntries(opportunities.map((o) => [o.asset.address, "fixture-attestation-not-valid-on-server"]));
writeFileSync(
  process.argv[2] ?? "/tmp/fixture.json",
  JSON.stringify({ ok: true, data: { evaluatedAt: now, signal: "CROSS_ISSUER", notional: 250, walletConnected: true, assetsDiscovered: 17 /* synthetic: 17 tokens discovered, 9 compared */, pairsFound: 5, pairsScanned: 5, opportunities, errors: [], attestations, cachedAt: now } }),
);
console.log(opportunities.map((o) => `${o.asset.symbol} ${o.action} ${o.spreadPercent.toFixed(2)}%`).join("\n"));
