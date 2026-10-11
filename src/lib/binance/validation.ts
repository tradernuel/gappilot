import { z } from "zod";
import { BinanceApiError } from "./errors";

/**
 * Input validation for every client method. Rules come from the spec's
 * parameter descriptions (formats, ranges, batch limits). A failed validation
 * throws BinanceApiError(kind "validation") and sends nothing.
 */

/** "56" (BSC), "1" (Ethereum), "8453" (Base), "CT_501" (Solana), "CT_195" (Tron). */
export const chainId = z.string().regex(/^(\d+|CT_\d+)$/, "must be a Binance chain id like \"56\"");
export const evmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be 0x + 40 hex chars");
/** Native asset is addressed with an empty string in balance endpoints. */
export const evmAddressOrNative = z.union([evmAddress, z.literal("")]);
export const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "must be 0x + 64 hex chars");
export const hexData = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "must be 0x-prefixed even-length hex");
/** Smallest-unit amount: positive integer string, no decimals (spec). */
export const rawAmount = z.string().regex(/^[1-9]\d*$/, "must be a positive integer string in smallest units");
/** wei value for a tx; zero allowed. */
export const weiValue = z.string().regex(/^(0|[1-9]\d*)$/, "must be a non-negative integer string (wei)");

export const percentString = (min: number, max: number, { exclusiveMin = false } = {}) =>
  z
    .string()
    .regex(/^\d+(\.\d+)?$/, "must be a decimal string like \"0.5\"")
    .refine((v) => {
      const n = Number(v);
      return (exclusiveMin ? n > min : n >= min) && n <= max;
    }, `must be ${exclusiveMin ? ">" : ">="} ${min} and <= ${max}`);

export const platformId = z.enum(["ondo", "bstock"]);

/** Parses `input` or throws a validation error naming every bad field. */
export function validate<S extends z.ZodType>(schema: S, input: unknown, endpoint: string): z.output<S> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.message,
  }));
  throw new BinanceApiError({
    kind: "validation",
    endpoint,
    issues,
    message: `Invalid input for ${endpoint}: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
  });
}

// ── Per-endpoint input schemas ───────────────────────────────────────────────

export const RwaInputs = {
  platforms: z.object({ platformId: platformId.optional() }).strict(),
  tokens: z
    .object({
      binanceChainId: chainId.optional(),
      platformId: platformId.optional(),
      tabId: z.number().int().min(1).max(13).optional(),
    })
    .strict(),
  price: z
    .object({
      binanceChainId: chainId,
      tokenContractAddresses: z.array(evmAddress).min(1).max(100, "spec allows at most 100 addresses"),
    })
    .strict(),
  token: z.object({ binanceChainId: chainId, tokenContractAddress: evmAddress }).strict(),
  search: z
    .object({ keyword: z.string().trim().min(1).max(100), platformId: platformId.optional() })
    .strict(),
};

export const MarketInputs = {
  token: z.object({ binanceChainId: chainId, tokenContractAddress: evmAddress }).strict(),
};

export const TradingInputs = {
  quote: z
    .object({
      binanceChainId: chainId,
      amount: rawAmount,
      fromTokenAddress: evmAddress,
      toTokenAddress: evmAddress,
      vendor: z.enum(["LiquidMesh", "Pancake", "Jupiter"]).optional(),
      userWalletAddress: evmAddress.optional(),
      feePercent: percentString(0, 5, { exclusiveMin: true }).optional(),
      feeSource: z.enum(["FROM_TOKEN", "TO_TOKEN"]).optional(),
    })
    .strict()
    .refine((v) => v.fromTokenAddress.toLowerCase() !== v.toTokenAddress.toLowerCase(), {
      message: "toTokenAddress must differ from fromTokenAddress",
      path: ["toTokenAddress"],
    })
    .refine((v) => (v.feePercent === undefined) === (v.feeSource === undefined), {
      message: "feePercent and feeSource must be provided together",
      path: ["feePercent"],
    }),
  buildSwap: z
    .object({
      binanceChainId: chainId,
      amount: rawAmount,
      fromTokenAddress: evmAddress,
      toTokenAddress: evmAddress,
      userWalletAddress: evmAddress,
      quoteId: z.string().min(1),
      slippagePercent: percentString(0, 100).optional(),
      autoSlippage: z.boolean().optional(),
      maxAutoSlippagePercent: percentString(0, 100).optional(),
      approveTransaction: z.boolean().optional(),
      approveAmount: rawAmount.optional(),
      gasLimit: rawAmount.optional(),
      gasLevel: z.enum(["slow", "average", "fast"]).optional(),
      priceImpactProtectionPercent: percentString(0, 100).optional(),
    })
    .strict()
    .refine((v) => v.slippagePercent !== undefined || v.autoSlippage === true, {
      message: "slippagePercent is required unless autoSlippage=true (spec)",
      path: ["slippagePercent"],
    }),
  approve: z
    .object({
      binanceChainId: chainId,
      tokenContractAddress: evmAddress,
      approveAmount: rawAmount,
      vendor: z.string().min(1).optional(),
    })
    .strict(),
  orderId: z.string().min(1).max(128),
  swapStatus: z.object({ binanceChainId: chainId, txHash }).strict(),
};

const evmTx = z
  .object({ from: evmAddress, to: evmAddress, value: weiValue, data: hexData })
  .strict();

export const TransactionInputs = {
  chain: chainId,
  simulate: z.object({ binanceChainId: chainId, evmTx }).strict(),
  gasLimit: z.object({ binanceChainId: chainId, evmTx }).strict(),
};

export const WalletInputs = {
  allBalances: z
    .object({
      address: evmAddress,
      chains: chainId.describe("spec: a single chain id"),
      excludeRiskToken: z.boolean().optional(),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  tokenBalances: z
    .object({
      address: evmAddress,
      tokenContractAddresses: z
        .array(z.object({ binanceChainId: chainId, tokenContractAddress: evmAddressOrNative }).strict())
        .min(1)
        .max(20, "spec allows at most 20 tokens"),
      excludeRiskToken: z.enum(["0", "1"]).optional(),
    })
    .strict(),
  txDetail: z.object({ binanceChainId: chainId, txHash }).strict(),
};
