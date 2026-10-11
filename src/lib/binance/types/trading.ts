import type { BinanceChainId, NumericString, RawAmount, UnixMs } from "./common";

/**
 * Trading (Aggregator) API —
 * https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/trading-api
 *
 * IMPORTANT (from the spec): "Equity / RWA tokens always return RFQ."
 * Flow: GET /quote → GET /swap → sign rfq.typedDataToSign (EIP-712,
 * eth_signTypedData_v4) → POST /order/submit → poll GET /order/{orderId}.
 */

export type ExecutionMode = "SWAP" | "RFQ" | (string & {});
export type GasLevel = "slow" | "average" | "fast";
export type QuoteVendor = "LiquidMesh" | "Pancake" | "Jupiter";
export type RfqVendor = "InchFusion" | "CowSwap" | "PcsXRfq";
export type FeeSource = "FROM_TOKEN" | "TO_TOKEN";

// ── GET /api/v1/dex/aggregator/quote ─────────────────────────────────────────
export interface GetQuoteParams {
  binanceChainId: BinanceChainId;
  /** Sell amount in smallest units (integer string). */
  amount: RawAmount;
  fromTokenAddress: string;
  toTokenAddress: string;
  /** Optional single-vendor fast path. */
  vendor?: QuoteVendor;
  /** REQUIRED for RFQ routes (Ondo / bStocks). Must match the wallet that later signs. */
  userWalletAddress?: string;
  /** Referral fee — GapPilot does not charge fees; listed for completeness. */
  feePercent?: string;
  feeSource?: FeeSource;
}

export interface QuoteToken {
  tokenContractAddress?: string;
  tokenSymbol?: string;
  /** USD unit price (decimal string). */
  tokenUnitPrice?: NumericString;
  decimal?: string;
  isHoneyPot?: boolean;
  /** 0–1; "0.01" = 1%. */
  taxRate?: NumericString;
}

export interface DexRouteHop {
  dexProtocol?: { dexName?: string; percent?: NumericString };
  fromToken?: { tokenContractAddress?: string; tokenSymbol?: string };
  fromTokenIndex?: string;
  toToken?: { tokenContractAddress?: string; tokenSymbol?: string };
  toTokenIndex?: string;
}

export interface QuoteRoute {
  /** UUID without dashes. TTL ≈ 30s; expired → QUOTE_EXPIRED (40401). */
  quoteId?: string;
  /** e.g. LiquidMesh, Lifi, 1inch, Pancake, Jupiter — or an RFQ vendor. */
  vendorName?: string;
  binanceChainId?: BinanceChainId;
  fromTokenAmount?: RawAmount;
  /** Estimated output, smallest units. */
  toTokenAmount?: RawAmount;
  /** Estimated network fee in USD. */
  tradeFee?: NumericString | null;
  /** Estimated gas in wei. */
  estimateGasFee?: RawAmount | null;
  priceImpactPercent?: NumericString | null;
  router?: string;
  fromToken?: QuoteToken;
  toToken?: QuoteToken;
  dexRouterList?: DexRouteHop[];
  executionMode?: ExecutionMode;
  /** Spender for ERC-20 approve. Null when no approval is needed. */
  approveTarget?: string | null;
  isBest?: boolean;
  feeAmount?: RawAmount | null;
  feeToken?: string | null;
  actualSwapAmount?: RawAmount | null;
}

/** /quote returns an ARRAY of routes; at most one has isBest=true. */
export type QuoteResponse = QuoteRoute[];

// ── GET /api/v1/dex/aggregator/swap ──────────────────────────────────────────
export interface BuildSwapParams {
  binanceChainId: BinanceChainId;
  amount: RawAmount;
  fromTokenAddress: string;
  toTokenAddress: string;
  userWalletAddress: string;
  quoteId: string;
  /** Required unless autoSlippage=true. "0.5" = 0.5%. */
  slippagePercent?: string;
  autoSlippage?: boolean;
  maxAutoSlippagePercent?: string;
  /** When true, approve calldata is included in signatureData. */
  approveTransaction?: boolean;
  approveAmount?: RawAmount;
  gasLimit?: string;
  gasLevel?: GasLevel;
  /** 0–100, default 90; 100 disables. */
  priceImpactProtectionPercent?: string;
}

export interface SwapTx {
  from?: string;
  /** DEX router contract. */
  to?: string;
  data?: string;
  /** wei; "0" for ERC-20 swaps. */
  value?: RawAmount;
  gas?: string;
  gasPrice?: string;
  maxPriorityFeePerGas?: string;
  /** Minimum output at the slippage limit (smallest units). */
  minReceiveAmount?: RawAmount;
  slippagePercent?: NumericString;
  signatureData?: string[];
  computeUnitPrice?: string | null;
  computeUnitLimit?: string | null;
}

export interface RfqPayload {
  /** Pass as `vendor` to /order/submit. */
  vendor?: RfqVendor | (string & {});
  /** Currently always "EIP712". */
  txType?: string;
  /** EIP-712 typed data for eth_signTypedData_v4 — hex or JSON-encoded string (spec says either). */
  typedDataToSign?: string;
  signingScheme?: string;
  /** JSON strings with approveContract + approveTxCalldata, when approveTransaction=true. */
  signatureData?: string[];
}

export interface SwapRouterResult {
  binanceChainId?: BinanceChainId;
  vendorName?: string;
  fromTokenAmount?: RawAmount;
  toTokenAmount?: RawAmount;
  tradeFee?: NumericString | null;
  estimateGasFee?: RawAmount | null;
  router?: string;
  /** (received_value − sent_value) / sent_value */
  priceImpactPercent?: NumericString;
  dexRouterList?: DexRouteHop[];
  fromToken?: QuoteToken;
  toToken?: QuoteToken;
  feeAmount?: RawAmount | null;
  feeToken?: string | null;
  actualSwapAmount?: RawAmount | null;
}

export interface BuildSwapResponse {
  routerResult?: SwapRouterResult;
  /** Present for SWAP mode. */
  tx?: SwapTx;
  executionMode?: ExecutionMode;
  /** Present for RFQ mode (all equity/RWA tokens). */
  rfq?: RfqPayload | null;
}

// ── GET /api/v1/dex/aggregator/approve-transaction ───────────────────────────
export interface GetApproveTxParams {
  binanceChainId: BinanceChainId;
  tokenContractAddress: string;
  approveAmount: RawAmount;
  /** REQUIRED for Ondo/bStocks: pass vendorName from /quote. */
  vendor?: string;
}
export interface ApproveTx {
  /** approve() calldata. */
  data?: string;
  /** The spender. */
  dexContractAddress?: string;
  gasLimit?: string;
  gasPrice?: string;
}
/** Returned as an array in the spec. */
export type ApproveTxResponse = ApproveTx[];

// ── POST /api/v1/dex/aggregator/order/submit ─────────────────────────────────
// Types only. No client method submits orders in this phase (execution not built).
export interface SubmitRfqOrderParams {
  /** UUID v4 idempotency key (30-minute window). Reuse on retry. */
  requestId: string;
  /** 0x + 65-byte EIP-712 signature. */
  userSignature: string;
  vendor: RfqVendor | (string & {});
  /**
   * ⚠ AMBIGUOUS: spec describes this as "`rfq.orderId` from the /swap response",
   * but the documented `rfq` object has no orderId field. Confirm with a live
   * /swap response before implementing execution.
   */
  quoteId: string;
  signingScheme?: string;
}
export interface SubmitRfqOrderResponse {
  orderId?: string;
  /** Typically PENDING_VENDOR. */
  status?: RfqOrderStatus;
  createdAt?: UnixMs;
}

// ── GET /api/v1/dex/aggregator/order/{orderId} ───────────────────────────────
export type RfqOrderStatus =
  | "PENDING_VENDOR"
  | "PENDING_ONCHAIN"
  | "FILLED"
  | "FAILED"
  | "EXPIRED"
  | "CANCELLED"
  | (string & {});

export const RFQ_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "FILLED",
  "FAILED",
  "EXPIRED",
  "CANCELLED",
]);

export interface RfqOrder {
  orderId?: string;
  status?: RfqOrderStatus;
  /** Present only when FILLED. */
  txHash?: string | null;
  fromAmount?: RawAmount | null;
  toAmount?: RawAmount | null;
  filledAt?: UnixMs | null;
  createdAt?: UnixMs;
}

// ── GET /api/v1/dex/aggregator/history  (swap tx status by hash) ─────────────
export interface GetSwapStatusParams {
  binanceChainId: BinanceChainId;
  txHash: string;
}
export interface SwapTxStatus {
  binanceChainId?: BinanceChainId;
  txHash?: string;
  height?: string;
  /** Unix ms as a string. */
  txTime?: string;
  /** "success" | "failed" */
  status?: string;
  fromAddress?: string;
  toAddress?: string;
  errorMsg?: string | null;
  gasLimit?: string | null;
  gasUsed?: string | null;
  gasPrice?: string | null;
  txFee?: string | null;
  priorityFee?: string | null;
  txType?: string | null;
  dexRouter?: string | null;
  fromTokenDetails?: Array<{ symbol?: string | null; amount?: RawAmount; tokenAddress?: string }> | null;
  toTokenDetails?: Array<{ symbol?: string | null; amount?: RawAmount; tokenAddress?: string }> | null;
}
/** Spec: transaction not found → data is null (not HTTP 404). */
export type SwapTxStatusResponse = SwapTxStatus | null;
