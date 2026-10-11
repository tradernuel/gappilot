/**
 * DEMO ONLY. A simulated Binance Web3 API: same paths, same {code,msg,data}
 * envelope and the same response shapes the real client validates, so
 * GapPilot's real scanner, planner, policy and runner run on top of it
 * unchanged. Fictional tickers, synthetic prices. Never used in production.
 */

export const DEMO_WALLET = "0xde3000000000000000000000000000000000d3a0";
export const DEMO_USDT = "0x55d398326f99059fF775485246999027B3197955";
const SPENDER = "0x1a0a18ac4becddbd6389559687d1a73d8927e416";
const E18 = 10n ** 18n;

interface DemoToken {
  address: string;
  issuer: "bstock" | "ondo";
  symbol: string;
  ticker: string;
  name: string;
  price: number;
  liquidityUsd: number | null;
  restricted?: string;
}

const addr = (n: number) => `0x${n.toString(16).padStart(4, "0")}${"0".repeat(32)}${n.toString(16).padStart(4, "0")}`;
let seq = 0x100;
const pair = (ticker: string, name: string, bPrice: number, oPrice: number, bLiq: number | null, oLiq: number | null, restricted?: string): DemoToken[] => [
  { address: addr(seq++), issuer: "bstock", symbol: `${ticker}b`, ticker, name, price: bPrice, liquidityUsd: bLiq, restricted },
  { address: addr(seq++), issuer: "ondo", symbol: `${ticker}on`, ticker, name, price: oPrice, liquidityUsd: oLiq, restricted },
];
const single = (ticker: string, name: string, issuer: "bstock" | "ondo", price: number, liq: number): DemoToken => ({
  address: addr(seq++), issuer, symbol: `${ticker}${issuer === "bstock" ? "b" : "on"}`, ticker, name, price, liquidityUsd: liq,
});

/** 17 fictional tokenized equities: 6 cross-issuer pairs + 5 single-issuer listings. */
const BASE: DemoToken[] = [
  ...pair("ACME", "Acme Industries (fictional)", 187.42, 185.61, 2_400_000, 1_900_000),
  ...pair("GLBX", "Globex Corp (fictional)", 412.1, 409.02, 860_000, 1_100_000),
  ...pair("NEBL", "Nebula Labs (fictional)", 64.2, 62.71, 900_000, 1_200_000),
  ...pair("UMBR", "Umbra Systems (fictional)", 23.95, 24.41, 18_000, 41_000),
  ...pair("INIT", "Initech (fictional)", 58.3, 58.24, 640_000, 720_000),
  ...pair("SOYL", "Soylent Foods (fictional)", 131.2, 129.9, null, null, "stock_split"),
  single("ZEPH", "Zephyr Air (fictional)", "bstock", 41.8, 300_000),
  single("QUIL", "Quill Media (fictional)", "ondo", 12.55, 150_000),
  single("BRAM", "Bramble Retail (fictional)", "bstock", 77.1, 220_000),
  single("TOVA", "Tova Health (fictional)", "ondo", 203.4, 480_000),
  single("NIMB", "Nimbus Cloud (fictional)", "bstock", 9.84, 95_000),
];

export type DemoMarket = "CLOSED" | "OPEN";

export interface DemoState {
  market: DemoMarket;
  /** Wallet holdings in whole units. */
  usdt: number;
  holdings: Record<string, number>;
}

export const demoState: DemoState = {
  market: "CLOSED",
  usdt: 1_000,
  holdings: { ACMEb: 12 },
};

/** Next US cash-session open (13:30 UTC on the next weekday), from `now`. */
export function nextOpen(now: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 13, 30);
  let candidate = t > now ? t : t + 86_400_000;
  while ([0, 6].includes(new Date(candidate).getUTCDay())) candidate += 86_400_000;
  return candidate;
}

/** Small deterministic-per-scan jitter so rescans look live without changing categories. */
let scanSeed = 1;
function jitter(symbol: string): number {
  let h = scanSeed * 2654435761;
  for (const c of symbol) h = Math.imul(h ^ c.charCodeAt(0), 2246822519);
  const u = ((h >>> 0) % 10_000) / 10_000 - 0.5; // −0.5..0.5
  return 1 + u * 0.0008; // ±0.04%
}

function tokensNow(): DemoToken[] {
  return BASE.map((t) => ({ ...t, price: Number((t.price * jitter(t.symbol)).toFixed(4)) }));
}

let current = tokensNow();
let quoteSeq = 0;
let lastApprove = 0n;

const find = (a: string | null) => current.find((t) => t.address.toLowerCase() === (a ?? "").toLowerCase());
const priceOf = (a: string) => find(a)?.price ?? 1;
const isUsdt = (a: string | null) => (a ?? "").toLowerCase() === DEMO_USDT.toLowerCase();
const FILL_BPS = 9_982n; // 0.18% execution shortfall vs mid

function outFor(from: string, to: string, amount: bigint): bigint {
  if (isUsdt(from)) return (amount * 1_000_000n * FILL_BPS) / (BigInt(Math.round(priceOf(to) * 1_000_000)) * 10_000n);
  return (amount * BigInt(Math.round(priceOf(from) * 1_000_000)) * FILL_BPS) / (1_000_000n * 10_000n);
}

function statusInfo(t: DemoToken, now: number) {
  if (t.restricted) return { openState: false, marketStatus: "pause", reasonCode: "ASSET_PAUSED", reasonMsg: t.restricted, nextOpenTime: null, nextCloseTime: null };
  if (demoState.market === "OPEN") return { openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null, nextOpenTime: null, nextCloseTime: now + 3 * 3_600_000 };
  const weekend = [0, 6].includes(new Date(now).getUTCDay());
  return { openState: false, marketStatus: "closed", reasonCode: "MARKET_CLOSED", reasonMsg: weekend ? "Weekend or Holiday" : "Outside regular hours", nextOpenTime: nextOpen(now), nextCloseTime: null };
}

/** Same shape as Binance's fetch: (url, init) → Response with the standard envelope. */
export async function demoBinanceFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const p = url.pathname.replace("/build/api/v1/dex", "");
  const q = url.searchParams;
  const now = Date.now();
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, msg: "success", data, timestamp: now, success: true }), { status: 200, headers: { "content-type": "application/json" } });

  switch (p) {
    case "/market/rwa/tokens": {
      scanSeed++; // a new discovery = a new scan: re-jitter prices
      current = tokensNow();
      const issuer = q.get("platformId");
      return ok(current.filter((t) => !issuer || t.issuer === issuer).map((t) => ({
        binanceChainId: "56", tokenContractAddress: t.address, platformId: t.issuer, tokenSymbol: t.symbol, tokenName: t.name,
        underlyingTicker: t.ticker, underlyingName: t.name, decimals: "18", tokenToShareRatio: "1",
        tokenPrice: String(t.price), referencePrice: String(t.price), statusInfo: statusInfo(t, now),
      })));
    }
    case "/market/rwa/price":
      return ok((q.get("tokenContractAddresses") ?? "").split(",").map(find).filter(Boolean).map((t) => ({
        binanceChainId: "56", tokenContractAddress: t!.address, platformId: t!.issuer, tokenPrice: String(t!.price), referencePrice: String(t!.price), tokenPriceUpdatedAt: now - 9_000,
      })));
    case "/market/token/top-liquidity": {
      const t = find(q.get("tokenContractAddress"));
      return ok(t?.liquidityUsd ? [{ pool: `${t.symbol}/USDT`, protocolName: "PancakeSwap", liquidityUsd: String(t.liquidityUsd), poolAddress: t.address }] : []);
    }
    case "/market/token/basic-info": {
      const a = q.get("tokenContractAddress");
      const t = find(a);
      return ok({ binanceChainId: "56", tokenContractAddress: a, tokenSymbol: isUsdt(a) ? "USDT" : t?.symbol ?? "TOKEN", tokenName: isUsdt(a) ? "Tether USD (demo)" : t?.name, decimals: 18 });
    }
    case "/balance/token-balances-by-address": {
      const body = JSON.parse(String(init?.body ?? "{}")) as { tokenContractAddresses?: Array<{ tokenContractAddress: string }> };
      return ok([{ tokenAssets: (body.tokenContractAddresses ?? []).map((x) => {
        const units = isUsdt(x.tokenContractAddress) ? demoState.usdt : demoState.holdings[find(x.tokenContractAddress)?.symbol ?? ""] ?? 0;
        return { binanceChainId: "56", tokenContractAddress: x.tokenContractAddress, rawBalance: (BigInt(Math.round(units * 1e6)) * 10n ** 12n).toString(), balance: String(units) };
      }) }]);
    }
    case "/aggregator/quote": {
      const from = q.get("fromTokenAddress")!, to = q.get("toTokenAddress")!, amount = BigInt(q.get("amount")!);
      return ok([{
        quoteId: `demo-q-${++quoteSeq}`, vendorName: "PcsXRfq", executionMode: "RFQ", isBest: true, approveTarget: SPENDER,
        fromTokenAmount: amount.toString(), toTokenAmount: outFor(from, to, amount).toString(),
        tradeFee: "0.03", estimateGasFee: "90000000000000", priceImpactPercent: "0.16",
        fromToken: { tokenContractAddress: from, decimal: "18", tokenUnitPrice: isUsdt(from) ? "1" : String(priceOf(from)) },
        toToken: { tokenContractAddress: to, decimal: "18", tokenUnitPrice: isUsdt(to) ? "1" : String(priceOf(to)) },
        dexRouterList: [{ dexProtocol: { dexName: "PancakeSwap RFQ", percent: "100" } }],
      }]);
    }
    case "/aggregator/approve-transaction": {
      lastApprove = BigInt(q.get("approveAmount")!);
      const data = `0x095ea7b3${SPENDER.slice(2).padStart(64, "0")}${lastApprove.toString(16).padStart(64, "0")}`;
      return ok([{ data, dexContractAddress: SPENDER, gasLimit: "52000", gasPrice: "1000000000" }]);
    }
    case "/aggregator/swap": {
      const from = q.get("fromTokenAddress")!, to = q.get("toTokenAddress")!, amount = BigInt(q.get("amount")!);
      const typed = { domain: { name: "PancakeSwap RFQ", chainId: 56 }, primaryType: "Order", message: { receiver: q.get("userWalletAddress"), sellAmount: amount.toString(), buyAmount: outFor(from, to, amount).toString(), deadline: Math.floor(now / 1000) + 120 } };
      return ok({ executionMode: "RFQ", rfq: { vendor: "PcsXRfq", txType: "EIP712", typedDataToSign: JSON.stringify(typed) } });
    }
    case "/pre-transaction/gas-price":
      return ok({ evmLegacyGasPrice: { lowGasPrice: "1000000000", mediumGasPrice: "1000000000", highGasPrice: "1500000000" } });
    case "/pre-transaction/simulate": {
      const tx = JSON.parse(String(init?.body ?? "{}")).evmTx;
      return ok({ status: "SUCCESS", failReason: null, allowanceChanges: [{ tokenAddress: tx.to, owner: tx.from, spender: SPENDER, preAmount: "0", postAmount: lastApprove.toString() }], balanceChanges: [] });
    }
    default:
      return new Response(JSON.stringify({ code: 40404, msg: `demo backend: no handler for ${p}` }), { status: 404 });
  }
}

/** Applies a simulated fill to the demo wallet so balances move after executions. */
export function applyDemoFill(side: "BUY" | "SELL", symbol: string, inputUnits: number, outputUnits: number) {
  if (side === "BUY") {
    demoState.usdt = Math.max(0, demoState.usdt - inputUnits);
    demoState.holdings[symbol] = (demoState.holdings[symbol] ?? 0) + outputUnits;
  } else {
    demoState.holdings[symbol] = Math.max(0, (demoState.holdings[symbol] ?? 0) - inputUnits);
    demoState.usdt += outputUnits;
  }
}

export const DEMO_E18 = E18;
