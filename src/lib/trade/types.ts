/**
 * Trade preview types. A preview is what the user reviews before approving.
 * It contains Binance-built transactions and simulation results; GapPilot
 * never writes calldata itself.
 */

export type PreviewStatus =
  /** Every simulatable step passed and every check holds. Confirmation allowed. */
  | "PASSED"
  /** A simulation failed or a check on its result failed. */
  | "FAILED"
  /** Stopped before building: rules, strategy, balance, quote or safety gate. */
  | "BLOCKED"
  /** SWAP route needs an approval mined first; the swap itself can't be simulated yet. */
  | "APPROVAL_REQUIRED"
  /** Nothing the Transaction API can simulate (e.g. RFQ with existing allowance), or typed data unreadable. */
  | "UNVERIFIABLE";

export type StepName = "STRATEGY" | "BALANCE" | "QUOTE" | "EXPECTED_OUTPUT" | "BUILD" | "SIMULATION";
export interface StepResult {
  step: StepName;
  status: "ok" | "failed" | "skipped";
  detail: string;
}

export interface TokenAmount {
  symbol: string;
  address: string;
  decimals: number;
  raw: string;
  amount: number;
  usd: number | null;
}

export interface SimulatedTx {
  kind: "APPROVE" | "SWAP";
  description: string;
  to: string;
  value: string;
  /** Binance-built calldata (shown for transparency; never edited). */
  data: string;
  gasLimit: string | null;
  simulation: { status: string; failReason: string | null; passed: boolean } | null;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
}

export interface TypedDataReview {
  decodable: boolean;
  primaryType: string | null;
  domainName: string | null;
  chainId: number | null;
  receiver: string | null;
  sellAmountRaw: string | null;
  buyAmountRaw: string | null;
  deadline: number | null;
  checks: Array<{ check: string; passed: boolean; detail: string }>;
}

export interface TradePreview {
  status: PreviewStatus;
  /** Why the status is what it is, in plain language. */
  headline: string;
  failureReason: string | null;
  steps: StepResult[];
  side: "BUY" | "SELL";
  wallet: string;
  input: TokenAmount | null;
  expectedOutput: TokenAmount | null;
  minimumOutput: (TokenAmount & { source: "TRANSACTION" | "TYPED_DATA" | "COMPUTED_FROM_SLIPPAGE" }) | null;
  priceImpactPercent: number | null;
  estimatedSlippagePercent: number | null;
  slippageLimitPercent: number;
  gas: { totalBnb: number | null; totalUsd: number | null; note: string };
  route: { vendor: string | null; executionMode: string | null; hops: Array<{ dex: string; percent: string | null }> };
  net: {
    /** Output valued at the on-chain mid minus input, minus gas (execution cost view). */
    vsMarketUsd: number | null;
    /** Output valued at the REFERENCE minus input, minus gas (the opportunity view). */
    vsReferenceUsd: number | null;
    vsReferencePercent: number | null;
  };
  transactions: SimulatedTx[];
  rfqOrder: TypedDataReview | null;
  warnings: string[];
  quoteId: string | null;
  createdAt: number;
  /** Approval must happen before this time (quote validity). */
  expiresAt: number;
  /** Server-signed plan token; required to approve. Present only when status is PASSED. */
  planToken: string | null;
  disclaimer: string;
}
