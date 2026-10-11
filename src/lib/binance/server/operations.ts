import { z } from "zod";
import type { BinanceWeb3Client } from "../facade";
import { BinanceApiError } from "../errors";
import { evmAddress, hexData, rawAmount, txHash, validate, weiValue } from "../validation";
import { BSC, RwaService } from "../../rwa/rwa-service";
import { OpportunityScanner } from "../../engine/scanner";

/** Server-supplied values (from env) that callers cannot override. */
export interface OperationContext {
  quoteTokenAddress?: string;
}

/**
 * Server-side operation registry behind /api/binance/[...op].
 *
 * Each operation: HTTP method, an input schema for the raw query/body (all
 * strings from the URL, hence coercion), and a runner. The chain is pinned to
 * BSC ("56") here — callers cannot pick another chain.
 *
 * Read-only by construction: there is no operation that builds, signs,
 * submits or broadcasts a trade. (`trading/quote` and `trading/approve` only
 * return data; `transaction/simulate` is a dry run.)
 */

type Method = "GET" | "POST";

interface Operation<S extends z.ZodType = z.ZodType> {
  method: Method;
  description: string;
  input: S;
  run: (client: BinanceWeb3Client, input: z.output<S>, ctx: OperationContext) => Promise<{ data: unknown; rateLimit?: unknown }>;
}

const op = <S extends z.ZodType>(o: Operation<S>) => o as unknown as Operation;

const addressList = z
  .string()
  .transform((s) => s.split(",").map((a) => a.trim()).filter(Boolean))
  .pipe(z.array(evmAddress).min(1).max(100));

const platform = z.enum(["ondo", "bstock"]);

export const OPERATIONS: Record<string, Operation> = {
  // ── RWA ────────────────────────────────────────────────────────────────────
  "rwa/platforms": op({
    method: "GET",
    description: "Issuers and per-chain token counts",
    input: z.object({ platformId: platform.optional() }),
    run: (c, i) => c.rwa.platforms(i),
  }),
  "rwa/tokens": op({
    method: "GET",
    description: "Tokenized stocks on BSC (optionally by issuer / sector tab)",
    input: z.object({ platformId: platform.optional(), tabId: z.coerce.number().int().optional() }),
    run: (c, i) => c.rwa.tokens({ binanceChainId: BSC, ...i }),
  }),
  "rwa/discover": op({
    method: "GET",
    description: "Both issuers on BSC, normalised and grouped by ticker",
    input: z.object({}),
    run: async (c) => ({ data: await new RwaService(c).discoverAssets() }),
  }),
  "rwa/search": op({
    method: "GET",
    description: "Find every issuer's token for a ticker, name or address",
    input: z.object({ keyword: z.string().min(1), platformId: platform.optional() }),
    run: (c, i) => c.rwa.search(i),
  }),
  "rwa/asset": op({
    method: "GET",
    description: "Profile + market data + status + price relationship for one token",
    input: z.object({ address: evmAddress }),
    run: async (c, i) => ({ data: await new RwaService(c).getAssetInfo(i.address) }),
  }),
  "rwa/price": op({
    method: "GET",
    description: "Raw /rwa/price for up to 100 comma-separated addresses",
    input: z.object({ addresses: addressList }),
    run: (c, i) => c.rwa.price({ binanceChainId: BSC, tokenContractAddresses: i.addresses }),
  }),
  "rwa/market-status": op({
    method: "GET",
    description: "Normalised market status for one token",
    input: z.object({ address: evmAddress }),
    run: async (c, i) => ({ data: await new RwaService(c).marketStatus(i.address) }),
  }),

  // ── Market ─────────────────────────────────────────────────────────────────
  "market/token": op({
    method: "GET",
    description: "Token basic info (decimals, symbol)",
    input: z.object({ address: evmAddress }),
    run: (c, i) => c.market.basicInfo({ binanceChainId: BSC, tokenContractAddress: i.address }),
  }),
  "market/liquidity": op({
    method: "GET",
    description: "Top DEX liquidity pools for a token",
    input: z.object({ address: evmAddress }),
    run: (c, i) => c.market.topLiquidity({ binanceChainId: BSC, tokenContractAddress: i.address }),
  }),

  // ── Wallet ─────────────────────────────────────────────────────────────────
  "wallet/balances": op({
    method: "GET",
    description: "All token balances for an address on BSC",
    input: z.object({
      address: evmAddress,
      page: z.coerce.number().int().min(1).optional(),
      pageSize: z.coerce.number().int().min(1).max(100).optional(),
    }),
    run: (c, i) => c.wallet.allTokenBalances({ chains: BSC, ...i }),
  }),
  "wallet/token-balances": op({
    method: "POST",
    description: "Balances of specific tokens (≤20) for an address",
    input: z.object({ address: evmAddress, tokens: z.array(z.union([evmAddress, z.literal("")])).min(1).max(20) }),
    run: (c, i) =>
      c.wallet.tokenBalances({
        address: i.address,
        tokenContractAddresses: i.tokens.map((t) => ({ binanceChainId: BSC, tokenContractAddress: t })),
      }),
  }),
  "wallet/tx": op({
    method: "GET",
    description: "Transaction detail by hash",
    input: z.object({ hash: txHash }),
    run: (c, i) => c.wallet.txDetail({ binanceChainId: BSC, txHash: i.hash }),
  }),

  // ── Trading (read-only) ────────────────────────────────────────────────────
  "trading/quote": op({
    method: "GET",
    description: "Aggregated quote (read-only). wallet is required for RFQ/equity routes",
    input: z.object({ from: evmAddress, to: evmAddress, amount: rawAmount, wallet: evmAddress.optional() }),
    run: (c, i) =>
      c.trading.quote({
        binanceChainId: BSC,
        fromTokenAddress: i.from,
        toTokenAddress: i.to,
        amount: i.amount,
        userWalletAddress: i.wallet,
      }),
  }),
  "trading/approve": op({
    method: "GET",
    description: "ERC-20 approve calldata (not sent). vendor required for Ondo/bStocks",
    input: z.object({ token: evmAddress, amount: rawAmount, vendor: z.string().min(1).optional() }),
    run: (c, i) =>
      c.trading.approveTransaction({
        binanceChainId: BSC,
        tokenContractAddress: i.token,
        approveAmount: i.amount,
        vendor: i.vendor,
      }),
  }),
  "trading/swap-status": op({
    method: "GET",
    description: "On-chain swap status by tx hash",
    input: z.object({ hash: txHash }),
    run: (c, i) => c.trading.swapTxStatus({ binanceChainId: BSC, txHash: i.hash }),
  }),
  "trading/rfq-order": op({
    method: "GET",
    description: "RFQ order status by orderId",
    input: z.object({ id: z.string().min(1).max(128) }),
    run: (c, i) => c.trading.rfqOrderStatus(i.id),
  }),

  // ── Opportunity engine ─────────────────────────────────────────────────────
  "opportunities/scan": op({
    method: "GET",
    description: "Cross-issuer scan through the deterministic engine. wallet enables quotes + executability",
    input: z.object({
      notional: z.coerce.number().positive().max(1_000_000).default(100),
      wallet: evmAddress.optional(),
      maxPairs: z.coerce.number().int().min(1).max(25).default(10),
    }),
    run: async (c, i, ctx) => {
      if (!ctx.quoteTokenAddress) throw new Error("quoteTokenAddress not configured");
      const data = await new OpportunityScanner(c).scan({
        notional: i.notional,
        wallet: i.wallet,
        maxPairs: i.maxPairs,
        quoteTokenAddress: ctx.quoteTokenAddress,
      });
      return { data };
    },
  }),

  // ── Transaction ────────────────────────────────────────────────────────────
  "transaction/gas-price": op({
    method: "GET",
    description: "Current BSC gas price tiers",
    input: z.object({}),
    run: (c) => c.transaction.gasPrice(BSC),
  }),
  "transaction/gas-limit": op({
    method: "POST",
    description: "Gas estimate for an EVM tx",
    input: z.object({ from: evmAddress, to: evmAddress, value: weiValue.default("0"), data: hexData.default("0x") }),
    run: (c, i) => c.transaction.gasLimit({ binanceChainId: BSC, evmTx: i }),
  }),
  "transaction/simulate": op({
    method: "POST",
    description: "Dry-run an EVM tx (nothing is broadcast)",
    input: z.object({ from: evmAddress, to: evmAddress, value: weiValue.default("0"), data: hexData.default("0x") }),
    run: (c, i) => c.transaction.simulate({ binanceChainId: BSC, evmTx: i }),
  }),
};

export type OperationName = keyof typeof OPERATIONS;

export interface OperationOk {
  ok: true;
  op: string;
  data: unknown;
  meta: { latencyMs: number; rateLimit?: unknown };
}
export interface OperationFail {
  ok: false;
  op: string;
  error: { kind: string; message: string; code?: number; upstreamStatus?: number; issues?: unknown };
}

/** Maps a failure to the HTTP status GapPilot returns to ITS caller. */
export function statusForError(err: unknown): number {
  if (!(err instanceof BinanceApiError)) return 500;
  switch (err.kind) {
    case "validation":
      return 400;
    case "timeout":
      return 504;
    case "http":
      return err.httpStatus === 429 ? 429 : 502; // 401/403 upstream = OUR key problem, not the caller's
    default:
      return 502; // business, parse, network
  }
}

/** Runs a named operation. Never throws; never includes secrets or raw upstream bodies. */
export async function runOperation(
  client: BinanceWeb3Client,
  name: string,
  method: string,
  rawInput: unknown,
  ctx: OperationContext = {},
): Promise<{ status: number; body: OperationOk | OperationFail }> {
  const operation = OPERATIONS[name];
  if (!operation) {
    return {
      status: 404,
      body: { ok: false, op: name, error: { kind: "not_found", message: `Unknown operation "${name}"` } },
    };
  }
  if (operation.method !== method) {
    return {
      status: 405,
      body: { ok: false, op: name, error: { kind: "method_not_allowed", message: `Use ${operation.method}` } },
    };
  }

  const started = Date.now();
  try {
    const input = validate(operation.input, rawInput, `api:${name}`);
    const result = await operation.run(client, input, ctx);
    return {
      status: 200,
      body: { ok: true, op: name, data: result.data, meta: { latencyMs: Date.now() - started, rateLimit: result.rateLimit } },
    };
  } catch (err) {
    const e = err instanceof BinanceApiError ? err : undefined;
    return {
      status: statusForError(err),
      body: {
        ok: false,
        op: name,
        error: {
          kind: e?.kind ?? "internal",
          message: e?.message ?? "Internal error",
          code: e?.code,
          upstreamStatus: e?.httpStatus,
          issues: e?.issues,
        },
      },
    };
  }
}
