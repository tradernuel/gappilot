/**
 * Fake Binance Web3 API for execution tests. Synthetic tokens/prices only.
 * Echoes requested amounts like the real API, serves scanner + planner
 * endpoints, issues a fresh quoteId per quote, and records every path.
 */
import { BinanceWeb3Client } from "../../src/lib/binance/facade";

export const NOW = 1_800_000_000_000;
export const E18 = 10n ** 18n;
export const WALLET = "0x7000000000000000000000000000000000000007";
export const ONDO_TOKEN = "0xa000000000000000000000000000000000000001"; // XYZon, $99
export const BSTOCK_TOKEN = "0xb000000000000000000000000000000000000002"; // XYZb, $100
export const USDT = "0x5000000000000000000000000000000000000005";
export const SPENDER = "0x9000000000000000000000000000000000000009";

export const encodeApprove = (spender: string, amount: bigint) =>
  `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;

export interface BackendOptions {
  stableBalance?: bigint;
  /** Output multiplier vs mid, e.g. 0.998 = 0.2% shortfall. */
  fill?: number;
  simulateStatus?: "SUCCESS" | "FAILED";
  now?: () => number;
}

export function binanceBackend(o: BackendOptions = {}) {
  const now = o.now ?? (() => NOW);
  const paths: string[] = [];
  let quoteSeq = 0;
  let lastApprove = 0n;
  const price = (addr: string) => (addr.toLowerCase() === ONDO_TOKEN ? 99 : 100);
  const fillBps = BigInt(Math.round((o.fill ?? 0.998) * 10_000));

  const outFor = (from: string, to: string, amount: bigint): bigint => {
    if (from.toLowerCase() === USDT) return (amount * 1_000_000n * fillBps) / (BigInt(price(to) * 1_000_000) * 10_000n);
    return (amount * BigInt(price(from) * 1_000_000) * fillBps) / (1_000_000n * 10_000n);
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const p = url.pathname.replace("/build/api/v1/dex", "");
    const q = url.searchParams;
    paths.push(p);
    const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, msg: "success", data, timestamp: now(), success: true }), { status: 200 });
    switch (p) {
      case "/market/rwa/tokens": {
        const issuer = q.get("platformId");
        const t = issuer === "ondo"
          ? { tokenContractAddress: ONDO_TOKEN, platformId: "ondo", tokenSymbol: "XYZon", underlyingTicker: "XYZ" }
          : { tokenContractAddress: BSTOCK_TOKEN, platformId: "bstock", tokenSymbol: "XYZb", underlyingTicker: "XYZ" };
        return ok([{ binanceChainId: "56", decimals: "18", tokenToShareRatio: "1", statusInfo: { openState: true, marketStatus: "regular", reasonCode: "TRADING" }, ...t }]);
      }
      case "/market/rwa/price":
        return ok([
          { tokenContractAddress: ONDO_TOKEN, tokenPrice: "99", tokenPriceUpdatedAt: now() - 5_000 },
          { tokenContractAddress: BSTOCK_TOKEN, tokenPrice: "100", tokenPriceUpdatedAt: now() - 5_000 },
        ]);
      case "/market/token/top-liquidity":
        return ok([{ liquidityUsd: "1000000" }]);
      case "/market/token/basic-info":
        return ok({ decimals: 18, tokenSymbol: "USDT" });
      case "/balance/token-balances-by-address": {
        const body = JSON.parse(String(init?.body));
        return ok([{ tokenAssets: body.tokenContractAddresses.map((t: { tokenContractAddress: string }) => ({
          tokenContractAddress: t.tokenContractAddress,
          rawBalance: t.tokenContractAddress.toLowerCase() === USDT ? (o.stableBalance ?? 1_000n * E18).toString() : "0",
        })) }]);
      }
      case "/aggregator/quote": {
        const from = q.get("fromTokenAddress")!, to = q.get("toTokenAddress")!, amount = BigInt(q.get("amount")!);
        return ok([{
          quoteId: `q-${++quoteSeq}`, vendorName: "PcsXRfq", executionMode: "RFQ", isBest: true, approveTarget: SPENDER,
          fromTokenAmount: amount.toString(), toTokenAmount: outFor(from, to, amount).toString(),
          tradeFee: "0.04", estimateGasFee: "100000000000000", priceImpactPercent: "0.2",
          fromToken: { tokenContractAddress: from, decimal: "18", tokenUnitPrice: from.toLowerCase() === USDT ? "1" : String(price(from)) },
          toToken: { tokenContractAddress: to, decimal: "18", tokenUnitPrice: to.toLowerCase() === USDT ? "1" : String(price(to)) },
          dexRouterList: [{ dexProtocol: { dexName: "PancakeSwap RFQ", percent: "100" } }],
        }]);
      }
      case "/aggregator/approve-transaction":
        lastApprove = BigInt(q.get("approveAmount")!);
        return ok([{ data: encodeApprove(SPENDER, lastApprove), dexContractAddress: SPENDER, gasLimit: "50000", gasPrice: "1000000000" }]);
      case "/aggregator/swap": {
        const from = q.get("fromTokenAddress")!, to = q.get("toTokenAddress")!, amount = BigInt(q.get("amount")!);
        const typed = { domain: { name: "PcsXRfq", chainId: 56 }, primaryType: "Order", message: { receiver: q.get("userWalletAddress"), sellAmount: amount.toString(), buyAmount: outFor(from, to, amount).toString(), deadline: Math.floor(now() / 1000) + 120 } };
        return ok({ executionMode: "RFQ", rfq: { vendor: "PcsXRfq", txType: "EIP712", typedDataToSign: JSON.stringify(typed) } });
      }
      case "/pre-transaction/gas-price":
        return ok({ evmLegacyGasPrice: { mediumGasPrice: "1000000000" } });
      case "/pre-transaction/simulate": {
        const tx = JSON.parse(String(init?.body)).evmTx;
        if (o.simulateStatus === "FAILED") return ok({ status: "FAILED", failReason: "execution reverted" });
        return ok({ status: "SUCCESS", allowanceChanges: [{ tokenAddress: tx.to, owner: tx.from, spender: SPENDER, preAmount: "0", postAmount: lastApprove.toString() }] });
      }
      default:
        throw new Error(`unexpected ${p}`);
    }
  }) as typeof fetch;

  const client = BinanceWeb3Client.create({ apiKey: "k", apiSecret: "s", baseUrl: "https://web3.binance.com/build", recvWindowMs: 5000, timeoutMs: 1000, fetchImpl, maxRetries: 0, now: () => new Date(now()) });
  return { client, paths };
}
