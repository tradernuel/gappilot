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
  contractAddress?: string;
  tokenType?: string;
  /** Signed delta in smallest units. Negative = outflow. */
  change?: string;
  owner?: string;
}
export interface SimulationAllowanceChange {
  tokenAddress?: string;
  owner?: string;
  spender?: string;
  preAmount?: RawAmount;
  postAmount?: RawAmount;
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
    lowGasPrice?: string;
    mediumGasPrice?: string;
    highGasPrice?: string;
  } | null;
  eip1559GasPrice?: {
    baseFee?: string;
    lowPriorityFee?: string;
    lowMaxFee?: string;
    mediumPriorityFee?: string;
    mediumMaxFee?: string;
    highPriorityFee?: string;
    highMaxFee?: string;
  } | null;
  solanaGasPrice?: unknown | null;
}

// ── POST /api/v1/dex/pre-transaction/gas-limit ───────────────────────────────
export interface GasLimitParams {
  binanceChainId: BinanceChainId;
  evmTx: EvmTx;
}
export interface GasLimit {
  gasLimit?: string;
}

// ── POST /api/v1/dex/pre-transaction/broadcast-transaction ───────────────────
// Typed for completeness. GapPilot phase 1 never broadcasts.
export interface BroadcastParams {
  binanceChainId: BinanceChainId;
  /** EVM: hex-encoded signed RLP tx. */
  signedTransaction: string;
  address: string;
  enableMevProtection?: boolean;
}
export interface BroadcastResult {
  orderId?: string;
  txHash?: string;
}

// ── GET /api/v1/dex/post-transaction/transaction-detail-by-txhash ────────────
export interface TxDetailParams {
  binanceChainId: BinanceChainId;
  txHash: string;
}
export interface TxDetail {
  /** NOTE: this endpoint uses `chainIndex`, not `binanceChainId`, in the response. */
  chainIndex?: string;
  height?: string;
  txTime?: string;
  txhash?: string;
  /** "success" | "fail" | "pending" */
  txStatus?: string;
  gasLimit?: string | null;
  gasUsed?: string | null;
  gasPrice?: string | null;
  txFee?: string;
  nonce?: string;
  amount?: string;
  symbol?: string;
  methodId?: string | null;
  fromDetails?: unknown[];
  toDetails?: unknown[];
  internalTransactionDetails?: unknown[];
  tokenTransferDetails?: Array<{
    from?: string;
    to?: string;
    isFromContract?: boolean | null;
    isToContract?: boolean | null;
    tokenContractAddress?: string;
    symbol?: string;
    amount?: string;
  }>;
}
/** Returned as an array in the spec. */
export type TxDetailResponse = TxDetail[];
