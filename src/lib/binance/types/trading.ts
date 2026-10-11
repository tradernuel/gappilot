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
  userWalletAddress?: string | null;
  /** Referral fee — GapPilot does not charge fees; listed for completeness. */
  feePercent?: string | null;
  feeSource?: FeeSource;
}

export interface QuoteToken {
  tokenContractAddress?: string | null;
  tokenSymbol?: string | null;
  /** USD unit price (decimal string). */
  tokenUnitPrice?: NumericString | null;
  decimal?: string | null;
  isHoneyPot?: boolean | null;
  /** 0–1; "0.01" = 1%. */
  taxRate?: NumericString | null;
}

export interface DexRouteHop {
  dexProtocol?: { dexName?: string | null; percent?: NumericString };
  fromToken?: { tokenContractAddress?: string | null; tokenSymbol?: string };
  fromTokenIndex?: string | null;
  toToken?: { tokenContractAddress?: string | null; tokenSymbol?: string };
  toTokenIndex?: string | null;
}

export interface QuoteRoute {
  /** UUID without dashes. TTL ≈ 30s; expired → QUOTE_EXPIRED (40401). */
  quoteId?: string | null;
  /** e.g. LiquidMesh, Lifi, 1inch, Pancake, Jupiter — or an RFQ vendor. */
  vendorName?: string | null;
  binanceChainId?: BinanceChainId | null;
  fromTokenAmount?: RawAmount | null;
  /** Estimated output, smallest units. */
  toTokenAmount?: RawAmount | null;
  /** Estimated network fee in USD. */
  tradeFee?: NumericString | null;
  /** Estimated gas in wei. */
  estimateGasFee?: RawAmount | null;
  priceImpactPercent?: NumericString | null;
  router?: string | null;
  fromToken?: QuoteToken;
  toToken?: QuoteToken;
  dexRouterList?: DexRouteHop[];
  executionMode?: ExecutionMode;
  /** Spender for ERC-20 approve. Null when no approval is needed. */
  approveTarget?: string | null;
  isBest?: boolean | null;
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
  slippagePercent?: string | null;
  autoSlippage?: boolean | null;
  maxAutoSlippagePercent?: string | null;
  /** When true, approve calldata is included in signatureData. */
  approveTransaction?: boolean | null;
  approveAmount?: RawAmount | null;
  gasLimit?: string | null;
  gasLevel?: GasLevel;
  /** 0–100, default 90; 100 disables. */
  priceImpactProtectionPercent?: string | null;
}

export interface SwapTx {
  from?: string | null;
  /** DEX router contract. */
  to?: string | null;
  data?: string | null;
  /** wei; "0" for ERC-20 swaps. */
  value?: RawAmount | null;
  gas?: string | null;
  gasPrice?: string | null;
  maxPriorityFeePerGas?: string | null;
  /** Minimum output at the slippage limit (smallest units). */
  minReceiveAmount?: RawAmount | null;
  slippagePercent?: NumericString | null;
  signatureData?: string[];
  computeUnitPrice?: string | null;
  computeUnitLimit?: string | null;
}

export interface RfqPayload {
  /** Pass as `vendor` to /order/submit. */
  vendor?: RfqVendor | (string & {});
  /** Currently always "EIP712". */
  txType?: string | null;
  /** EIP-712 typed data for eth_signTypedData_v4 — hex or JSON-encoded string (spec says either). */
  typedDataToSign?: string | null;
  signingScheme?: string | null;
  /** JSON strings with approveContract + approveTxCalldata, when approveTransaction=true. */
  signatureData?: string[];
}

export interface SwapRouterResult {
  binanceChainId?: BinanceChainId | null;
  vendorName?: string | null;
  fromTokenAmount?: RawAmount | null;
  toTokenAmount?: RawAmount | null;
  tradeFee?: NumericString | null;
  estimateGasFee?: RawAmount | null;
  router?: string | null;
  /** (received_value − sent_value) / sent_value */
  priceImpactPercent?: NumericString | null;
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
  vendor?: string | null;
}
export interface ApproveTx {
  /** approve() calldata. */
  data?: string | null;
  /** The spender. */
  dexContractAddress?: string | null;
  gasLimit?: string | null;
  gasPrice?: string | null;
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
  signingScheme?: string | null;
}
export interface SubmitRfqOrderResponse {
  orderId?: string | null;
  /** Typically PENDING_VENDOR. */
  status?: RfqOrderStatus;
  createdAt?: UnixMs | null;
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
  orderId?: string | null;
  status?: RfqOrderStatus;
  /** Present only when FILLED. */
  txHash?: string | null;
  fromAmount?: RawAmount | null;
  toAmount?: RawAmount | null;
  filledAt?: UnixMs | null;
  createdAt?: UnixMs | null;
}

// ── GET /api/v1/dex/aggregator/history  (swap tx status by hash) ─────────────
export interface GetSwapStatusParams {
  binanceChainId: BinanceChainId;
  txHash: string;
}
export interface SwapTxStatus {
  binanceChainId?: BinanceChainId | null;
  txHash?: string | null;
  height?: string | null;
  /** Unix ms as a string. */
  txTime?: string | null;
  /** "success" | "failed" */
  status?: string | null;
  fromAddress?: string | null;
  toAddress?: string | null;
  errorMsg?: string | null;
  gasLimit?: string | null;
  gasUsed?: string | null;
  gasPrice?: string | null;
  txFee?: string | null;
  priorityFee?: string | null;
  txType?: string | null;
  dexRouter?: string | null;
  fromTokenDetails?: Array<{ symbol?: string | null; amount?: RawAmount | null; tokenAddress?: string }> | null;
  toTokenDetails?: Array<{ symbol?: string | null; amount?: RawAmount | null; tokenAddress?: string }> | null;
}
/** Spec: transaction not found → data is null (not HTTP 404). */
export type SwapTxStatusResponse = SwapTxStatus | null;
