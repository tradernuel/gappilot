import { z } from "zod";

/**
 * Runtime response-shape checks.
 *
 * These are LOOSE: unknown extra fields pass through untouched, and every field
 * is optional because the spec marks them optional. They catch structural
 * breakage — an object where an array was promised, a number where the spec
 * says string — so malformed data fails loudly at the boundary instead of
 * becoming NaN deep inside the engine.
 *
 * Field types follow @binance-web3/wallet@13.0.1. If a live response
 * contradicts them, the error names the exact path; record it in
 * docs/binance-api-findings.md.
 */

const str = z.string();
const num = z.number();
const optStr = str.optional();
const nulStr = str.nullish();
const optNum = num.optional();
const nulNum = num.nullish();

const statusInfo = z.looseObject({
  openState: z.boolean().optional(),
  marketStatus: nulStr,
  reasonCode: nulStr,
  reasonMsg: nulStr,
  nextOpenTime: nulNum,
  nextCloseTime: nulNum,
});

// ── RWA ──────────────────────────────────────────────────────────────────────
export const RwaPlatformsSchema = z.array(
  z.looseObject({
    platformId: optStr,
    tickerCount: optNum,
    chainDistribution: z.array(z.looseObject({ binanceChainId: optStr, tokenCount: optNum })).optional(),
    website: nulStr,
    logoUrl: nulStr,
  }),
);

export const RwaTokensSchema = z.array(
  z.looseObject({
    binanceChainId: optStr,
    tokenContractAddress: optStr,
    platformId: optStr,
    assetType: optNum,
    tokenName: optStr,
    tokenSymbol: optStr,
    decimals: optStr,
    underlyingTicker: optStr,
    underlyingName: optStr,
    tokenToShareRatio: optStr,
    tags: z.array(str).nullish(),
    statusInfo: statusInfo.optional(),
    tokenPrice: optStr,
    referencePrice: optStr,
    volume24H: optStr,
    marketCap: optStr,
    peRatioTTM: nulStr,
  }),
);

export const RwaPriceSchema = z.array(
  z.looseObject({
    binanceChainId: optStr,
    tokenContractAddress: optStr,
    platformId: optStr,
    tokenPrice: optStr,
    referencePrice: optStr,
    tokenPriceUpdatedAt: optNum,
  }),
);

export const RwaUnderlyingProfileSchema = z.looseObject({
  binanceChainId: optStr,
  tokenContractAddress: optStr,
  platformId: optStr,
  underlyingTicker: optStr,
  underlyingFullName: optStr,
  assetType: optNum,
  tokenToShareRatio: optStr,
  protections: z.record(str, z.looseObject({ supported: z.boolean().optional(), url: nulStr }).optional()).optional(),
  companyInfo: z.looseObject({}).nullish(),
});

export const RwaUnderlyingMarketSchema = z.looseObject({
  binanceChainId: optStr,
  tokenContractAddress: optStr,
  platformId: optStr,
  assetType: optNum,
  statusInfo: statusInfo.optional(),
  marketData: z
    .looseObject({
      referencePrice: optStr,
      high52W: optStr,
      low52W: optStr,
      volumeShares24H: optStr,
      marketCap: optStr,
    })
    .optional(),
});

export const RwaSearchSchema = z.array(
  z.looseObject({
    ticker: optStr,
    companyName: optStr,
    assets: z
      .array(
        z.looseObject({
          platformId: optStr,
          binanceChainId: optStr,
          tokenContractAddress: optStr,
          tokenSymbol: optStr,
          assetType: optNum,
        }),
      )
      .optional(),
  }),
);

// ── Market ───────────────────────────────────────────────────────────────────
export const TokenBasicInfoSchema = z.looseObject({
  binanceChainId: optStr,
  tokenContractAddress: optStr,
  tokenName: optStr,
  tokenSymbol: optStr,
  decimals: optNum,
});

export const TopLiquiditySchema = z.array(
  z.looseObject({
    pool: optStr,
    protocolName: nulStr,
    liquidityUsd: optStr,
    poolAddress: optStr,
    liquidityAmount: z.array(z.looseObject({ tokenAmount: optStr, tokenSymbol: optStr })).optional(),
  }),
);

// ── Trading ──────────────────────────────────────────────────────────────────
const quoteToken = z.looseObject({
  tokenContractAddress: optStr,
  tokenSymbol: optStr,
  tokenUnitPrice: optStr,
  decimal: optStr,
  isHoneyPot: z.boolean().optional(),
  taxRate: optStr,
});

export const QuoteSchema = z.array(
  z.looseObject({
    quoteId: optStr,
    vendorName: optStr,
    fromTokenAmount: optStr,
    toTokenAmount: optStr,
    tradeFee: nulStr,
    estimateGasFee: nulStr,
    priceImpactPercent: nulStr,
    fromToken: quoteToken.optional(),
    toToken: quoteToken.optional(),
    executionMode: optStr,
    approveTarget: nulStr,
    isBest: z.boolean().optional(),
  }),
);

export const BuildSwapSchema = z.looseObject({
  routerResult: z.looseObject({ toTokenAmount: optStr, priceImpactPercent: optStr }).optional(),
  tx: z.looseObject({ to: optStr, data: optStr, value: optStr, minReceiveAmount: optStr }).optional(),
  executionMode: optStr,
  rfq: z.looseObject({ vendor: optStr, typedDataToSign: optStr, signingScheme: optStr }).nullish(),
});

export const ApproveTxSchema = z.array(
  z.looseObject({ data: optStr, dexContractAddress: optStr, gasLimit: optStr, gasPrice: optStr }),
);

export const RfqOrderSchema = z.looseObject({
  orderId: optStr,
  status: optStr,
  txHash: nulStr,
  fromAmount: nulStr,
  toAmount: nulStr,
  filledAt: nulNum,
  createdAt: optNum,
});

/** Spec: data is null when the tx is not found. */
export const SwapTxStatusSchema = z
  .looseObject({
    txHash: optStr,
    status: optStr,
    errorMsg: nulStr,
    gasUsed: nulStr,
    txFee: nulStr,
  })
  .nullable();

// ── Transaction ──────────────────────────────────────────────────────────────
export const SimulationSchema = z.looseObject({
  status: optStr,
  failReason: nulStr,
  balanceChanges: z
    .array(z.looseObject({ contractAddress: optStr, tokenType: optStr, change: optStr, owner: optStr }))
    .optional(),
  allowanceChanges: z
    .array(z.looseObject({ tokenAddress: optStr, owner: optStr, spender: optStr, preAmount: optStr, postAmount: optStr }))
    .optional(),
});

export const GasPriceSchema = z.looseObject({
  evmLegacyGasPrice: z.looseObject({ lowGasPrice: optStr, mediumGasPrice: optStr, highGasPrice: optStr }).nullish(),
  eip1559GasPrice: z.looseObject({ baseFee: optStr, mediumMaxFee: optStr, mediumPriorityFee: optStr }).nullish(),
});

export const GasLimitSchema = z.looseObject({ gasLimit: optStr });

// ── Wallet ───────────────────────────────────────────────────────────────────
const tokenBalance = z.looseObject({
  binanceChainId: optStr,
  tokenContractAddress: optStr,
  symbol: optStr,
  balance: optStr,
  rawBalance: optStr,
  tokenPrice: optStr,
  isRiskToken: z.boolean().optional(),
});

export const AllBalancesSchema = z.array(
  z.looseObject({ page: optNum, pageSize: optNum, tokenAssets: z.array(tokenBalance).optional() }),
);

export const TokenBalancesSchema = z.array(z.looseObject({ tokenAssets: z.array(tokenBalance).optional() }));

export const TxDetailSchema = z.array(
  z.looseObject({
    chainIndex: optStr,
    txhash: optStr,
    txStatus: optStr,
    txFee: optStr,
    tokenTransferDetails: z
      .array(z.looseObject({ from: optStr, to: optStr, tokenContractAddress: optStr, symbol: optStr, amount: optStr }))
      .optional(),
  }),
);
