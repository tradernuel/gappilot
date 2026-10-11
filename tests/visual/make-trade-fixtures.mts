/**
 * VISUAL QA ONLY. Runs the REAL trade planner against a fake Binance backend
 * for the fixture's ACMEb opportunity (fictional ticker, synthetic numbers),
 * producing PASSED / FAILED / UNVERIFIABLE previews for screenshots.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { buildTradePreview } from "../../src/lib/trade/planner";
import { attachPlanToken } from "../../src/lib/trade/approval";
import { DEFAULT_USER_RULES } from "../../src/lib/agent/types";
import type { Opportunity } from "../../src/lib/engine/types";
import { BinanceWeb3Client } from "../../src/lib/binance/facade";

type Responder = (url: URL, init: RequestInit) => Response;
const envelope = (data: unknown) => ({ code: 0, msg: "success", data, timestamp: Date.now(), success: true });
const json = (status: number, body: unknown): Responder => () => new Response(JSON.stringify(body), { status });
const fakeFetch = (r: Responder) => ({ impl: (async (input: string | URL | Request, init?: RequestInit) => r(new URL(String(input)), init ?? {})) as typeof fetch });
const apiClient = (fetchImpl: typeof fetch, extra: object = {}) =>
  BinanceWeb3Client.create({ apiKey: "visual-key", apiSecret: "visual-secret", baseUrl: "https://web3.binance.com/build", recvWindowMs: 5000, timeoutMs: 1000, fetchImpl, ...extra });

const fx = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/fixture.json", "utf8"));
const o: Opportunity = fx.data.opportunities.find((x: Opportunity) => x.asset.symbol === "ACMEb");
const WALLET = "0x7f3a00000000000000000000000000000000c41d";
const USDT = "0x55d398326f99059fF775485246999027B3197955";
const SPENDER = "0x1a0a18ac4becddbd6389559687d1a73d8927e416";
const now = Date.now();
const E18 = 10n ** 18n;
// The fake API echoes whatever amount the planner requests, like the real API.
let amount = 0n;
const outFor = (a: bigint) => (a * BigInt(Math.round(o.onChainTokenPrice * 1e6)) * 9982n) / 10000n / 10n ** 6n;
const approveData = (amt: bigint) => `0x095ea7b3${SPENDER.slice(2).padStart(64, "0")}${amt.toString(16).padStart(64, "0")}`;

function backend(opts: { simFail?: string; approveTarget?: string | null }) {
  return fakeFetch((url, init) => {
    const p = url.pathname.replace("/build/api/v1/dex", "");
    const ok = (d: unknown) => json(200, envelope(d))(url, init);
    if (p === "/market/token/basic-info") return ok({ decimals: 18, tokenSymbol: "USDT" });
    if (p === "/balance/token-balances-by-address") return ok([{ tokenAssets: [{ tokenContractAddress: o.asset.address, rawBalance: (12n * E18).toString() }] }]);
    if (p === "/aggregator/quote") amount = BigInt(url.searchParams.get("amount")!);
    const out = outFor(amount);
    if (p === "/aggregator/quote") return ok([{ quoteId: "q-visual", vendorName: "PcsXRfq", executionMode: "RFQ", isBest: true, approveTarget: opts.approveTarget === undefined ? SPENDER : opts.approveTarget, fromTokenAmount: url.searchParams.get("amount"), toTokenAmount: out.toString(), tradeFee: "0.03", estimateGasFee: "90000000000000", priceImpactPercent: "0.16", fromToken: { decimal: "18", tokenUnitPrice: String(o.onChainTokenPrice) }, toToken: { decimal: "18", tokenUnitPrice: "1" }, dexRouterList: [{ dexProtocol: { dexName: "PancakeSwap RFQ", percent: "100" } }] }]);
    if (p === "/aggregator/approve-transaction") return ok([{ data: approveData(amount), dexContractAddress: SPENDER, gasLimit: "52000", gasPrice: "1000000000" }]);
    if (p === "/aggregator/swap") return ok({ executionMode: "RFQ", rfq: { vendor: "PcsXRfq", txType: "EIP712", typedDataToSign: JSON.stringify({ domain: { name: "PancakeSwap RFQ", chainId: 56 }, primaryType: "Order", message: { receiver: WALLET, sellAmount: amount.toString(), buyAmount: out.toString(), deadline: Math.floor(now / 1000) + 120 } }) } });
    if (p === "/pre-transaction/gas-price") return ok({ evmLegacyGasPrice: { mediumGasPrice: "1000000000" } });
    if (p === "/pre-transaction/simulate") return ok(opts.simFail ? { status: "FAILED", failReason: opts.simFail } : { status: "SUCCESS", allowanceChanges: [{ tokenAddress: o.asset.address, owner: WALLET, spender: SPENDER, preAmount: "0", postAmount: amount.toString() }] });
    throw new Error(p);
  });
}

const make = async (opts: Parameters<typeof backend>[0]) => {
  const p = await buildTradePreview({ client: apiClient(backend(opts).impl, { maxRetries: 0 }), opportunity: { ...o, evaluatedAt: now }, wallet: WALLET, rules: DEFAULT_USER_RULES, quoteTokenAddress: USDT, now: () => Date.now() });
  return { ok: true, data: attachPlanToken(p, "visual-secret", { rules: DEFAULT_USER_RULES, strategy: null }) };
};

const result = {
  passed: await make({}),
  failed: await make({ simFail: "execution reverted: ERC20: approve to a paused token" }),
  unverifiable: await make({ approveTarget: null }),
};
writeFileSync(process.argv[3] ?? "/tmp/trade-fixtures.json", JSON.stringify(result));
console.log(Object.entries(result).map(([k, v]) => `${k}: ${v.data.status}`).join(", "));
