import type { BinanceChainId, RawAmount } from "./common";

/**
 * Transaction API —
 * https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/transaction-api
 */

/** EVM transaction for simulate / gas-limit. Only the EVM variant is used on BSC. */
export interface EvmTx {
  from: string;
  to: string;
  /** wei, integer string ("0" for ERC-20 calls). */
  value: RawAmount;
  /** ABI-encoded calldata (hex). */
  data: string;
}

// ── POST /api/v1/dex/pre-transaction/simulate ────────────────────────────────
export interface SimulateParams {
  binanceChainId: BinanceChainId;
  /** Spec marks evmTx/solTx/tronTx all "required for rendering"; supply exactly one. */
  evmTx: EvmTx;
}
export interface SimulationBalanceChange {
  /** Empty / native marker for BNB. */
  contractAddress?: string | null;
  tokenType?: string | null;
  /** Signed delta in smallest units. Negative = outflow. */
  change?: string | null;
  owner?: string | null;
}
export interface SimulationAllowanceChange {
  tokenAddress?: string | null;
  owner?: string | null;
  spender?: string | null;
  preAmount?: RawAmount | null;
  postAmount?: RawAmount | null;
}
export interface SimulationResult {
  /** Spec only gives SUCCESS / FAILED as examples — treat as open string. */
  status?: "SUCCESS" | "FAILED" | (string & {});
  failReason?: string | null;
  balanceChanges?: SimulationBalanceChange[];
  allowanceChanges?: SimulationAllowanceChange[];
}

// ── GET /api/v1/dex/pre-transaction/gas-price ────────────────────────────────
export interface GasPrice {
  evmLegacyGasPrice?: {
    lowGasPrice?: string | null;
    mediumGasPrice?: string | null;
    highGasPrice?: string | null;
  } | null;
  eip1559GasPrice?: {
    baseFee?: string | null;
    lowPriorityFee?: string | null;
    lowMaxFee?: string | null;
    mediumPriorityFee?: string | null;
    mediumMaxFee?: string | null;
    highPriorityFee?: string | null;
    highMaxFee?: string | null;
  } | null;
  solanaGasPrice?: unknown | null;
}

// ── POST /api/v1/dex/pre-transaction/gas-limit ───────────────────────────────
export interface GasLimitParams {
  binanceChainId: BinanceChainId;
  evmTx: EvmTx;
}
export interface GasLimit {
  gasLimit?: string | null;
}

// ── POST /api/v1/dex/pre-transaction/broadcast-transaction ───────────────────
// Typed for completeness. GapPilot phase 1 never broadcasts.
export interface BroadcastParams {
  binanceChainId: BinanceChainId;
  /** EVM: hex-encoded signed RLP tx. */
  signedTransaction: string;
  address: string;
  enableMevProtection?: boolean | null;
}
export interface BroadcastResult {
  orderId?: string | null;
  txHash?: string | null;
}

// ── GET /api/v1/dex/post-transaction/transaction-detail-by-txhash ────────────
export interface TxDetailParams {
  binanceChainId: BinanceChainId;
  txHash: string;
}
export interface TxDetail {
  /** NOTE: this endpoint uses `chainIndex`, not `binanceChainId`, in the response. */
  chainIndex?: string | null;
  height?: string | null;
  txTime?: string | null;
  txhash?: string | null;
  /** "success" | "fail" | "pending" */
  txStatus?: string | null;
  gasLimit?: string | null;
  gasUsed?: string | null;
  gasPrice?: string | null;
  txFee?: string | null;
  nonce?: string | null;
  amount?: string | null;
  symbol?: string | null;
  methodId?: string | null;
  fromDetails?: unknown[];
  toDetails?: unknown[];
  internalTransactionDetails?: unknown[];
  tokenTransferDetails?: Array<{
    from?: string | null;
    to?: string | null;
    isFromContract?: boolean | null;
    isToContract?: boolean | null;
    tokenContractAddress?: string | null;
    symbol?: string | null;
    amount?: string | null;
  }>;
}
/** Returned as an array in the spec. */
export type TxDetailResponse = TxDetail[];
