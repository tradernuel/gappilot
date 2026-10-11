import type { BinanceChainId, NumericString, UnixMs } from "./common";

/**
 * RWA Data API — https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api/rwa-data
 * Mirrors @binance-web3/wallet@13.0.1 models.
 */

/** Platform ids accepted by `platformId` filters. ondo = Ondo Finance, bstock = bStocks. */
export type RwaPlatformId = "ondo" | "bstock";

/** 1 = Stock, 2 = Pre-IPO, 3 = ETF. */
export type RwaAssetType = 1 | 2 | 3;

/**
 * Documented values. Typed as open strings because the spec gives them in prose,
 * not as an enum, and third-party reports say `marketStatus` can be null.
 */
export type RwaMarketStatus =
  | "premarket"
  | "regular"
  | "postmarket"
  | "overnight"
  | "closed"
  | "pause"
  | (string & {});

export type RwaReasonCode =
  | "MARKET_CLOSED"
  | "MARKET_PAUSED"
  | "MARKET_MAINTENANCE"
  | "ASSET_PAUSED"
  | "ASSET_LIMITED"
  | "TRADING"
  | "UNSUPPORTED"
  | (string & {});

export interface RwaStatusInfo {
  /** Whether the underlying market is currently tradable. */
  openState?: boolean | null;
  marketStatus?: RwaMarketStatus | null;
  /** Returned when openState=false. ASSET_PAUSED covers corporate actions (see reasonMsg). */
  reasonCode?: RwaReasonCode | null;
  /** e.g. "Weekend or Holiday"; for ASSET_PAUSED: cash_dividend, stock_split, merger, ...; for ASSET_LIMITED: earnings. */
  reasonMsg?: string | null;
  nextOpenTime?: UnixMs | null;
  nextCloseTime?: UnixMs | null;
}

// ── GET /api/v1/dex/market/rwa/platforms ─────────────────────────────────────
export interface GetRwaPlatformsParams {
  platformId?: RwaPlatformId;
}
export interface RwaPlatform {
  platformId?: string | null;
  /** Number of underlying assets. */
  tickerCount?: number | null;
  chainDistribution?: Array<{ binanceChainId?: BinanceChainId | null; tokenCount?: number }>;
  website?: string | null;
  logoUrl?: string | null;
}

// ── GET /api/v1/dex/market/rwa/tokens ────────────────────────────────────────
export interface GetRwaTokensParams {
  binanceChainId?: BinanceChainId | null;
  platformId?: RwaPlatformId;
  /**
   * Sector tab. 1=Serenity Call, 2=SpaceX, 3=Upcoming Earnings, 4=AI Chips, 5=Storage,
   * 6=Energy, 7=Precious Metals, 8=China ADR, 9=Magnificent 7, 10=Crypto, 11=ETF,
   * 12=Tech Leaders, 13=Buffett Portfolio.
   */
  tabId?: number | null;
}
export interface RwaToken {
  binanceChainId?: BinanceChainId | null;
  tokenContractAddress?: string | null;
  platformId?: string | null;
  assetType?: RwaAssetType | number;
  tokenName?: string | null;
  tokenSymbol?: string | null;
  tokenLogoUrl?: string | null;
  /** NOTE: string in this endpoint, number in /market/token/basic-info. */
  decimals?: string | null;
  underlyingTicker?: string | null;
  underlyingName?: string | null;
  underlyingNameZh?: string | null;
  /** "1.003701" means 1 token ≈ 1.003701 underlying shares. */
  tokenToShareRatio?: NumericString | null;
  tags?: string[] | null;
  statusInfo?: RwaStatusInfo;
  /** On-chain token price (USD). */
  tokenPrice?: NumericString | null;
  /**
   * Per-share price DERIVED FROM THE ON-CHAIN TOKEN PRICE.
   * Per the spec this is NOT an official quote from the traditional market.
   * Do not treat (tokenPrice vs referencePrice) as a TradFi gap.
   */
  referencePrice?: NumericString | null;
  volume24H?: NumericString | null;
  marketCap?: NumericString | null;
  peRatioTTM?: NumericString | null;
}

// ── GET /api/v1/dex/market/rwa/price ─────────────────────────────────────────
export interface GetRwaPriceParams {
  binanceChainId: BinanceChainId;
  /** Up to 100 addresses; the client joins them with commas. */
  tokenContractAddresses: string[];
}
export interface RwaPrice {
  binanceChainId?: BinanceChainId | null;
  tokenContractAddress?: string | null;
  platformId?: string | null;
  tokenPrice?: NumericString | null;
  /** Derived from tokenPrice — see RwaToken.referencePrice. */
  referencePrice?: NumericString | null;
  /** Token price last updated, Unix ms. Our only documented price-age signal. */
  tokenPriceUpdatedAt?: UnixMs | null;
}

// ── GET /api/v1/dex/market/rwa/underlying-profile ────────────────────────────
export interface RwaTokenParams {
  binanceChainId: BinanceChainId;
  tokenContractAddress: string;
}
export interface RwaProtection {
  supported?: boolean | null;
  url?: string | null;
}
export interface RwaUnderlyingProfile {
  binanceChainId?: BinanceChainId | null;
  tokenContractAddress?: string | null;
  platformId?: string | null;
  underlyingTicker?: string | null;
  underlyingFullName?: string | null;
  assetType?: RwaAssetType | number;
  tokenToShareRatio?: NumericString | null;
  /** Known keys: dailyAttestationReport, monthlyAttestationReport, collateralReport. */
  protections?: Record<string, RwaProtection | undefined>;
  companyInfo?: {
    ceo?: string | null;
    website?: string | null;
    industry?: string | null;
    conceptsEn?: string[] | null;
    conceptsCn?: string[] | null;
    descriptionEn?: string | null;
    descriptionZh?: string | null;
  } | null;
}

// ── GET /api/v1/dex/market/rwa/underlying-market ─────────────────────────────
export interface RwaUnderlyingMarketData {
  /** Derived from the on-chain token price — not an official quote. */
  referencePrice?: NumericString | null;
  high52W?: NumericString | null;
  low52W?: NumericString | null;
  volumeShares24H?: NumericString | null;
  avgDailyVolume1Y?: NumericString | null;
  totalShares?: NumericString | null;
  marketCap?: NumericString | null;
  /** "23.81" = 23.81% */
  turnoverRate?: NumericString | null;
  amplitude?: NumericString | null;
  peRatioTTM?: NumericString | null;
  pbRatio?: NumericString | null;
  dividendYield?: NumericString | null;
  latestDividend?: NumericString | null;
}
export interface RwaUnderlyingMarket {
  binanceChainId?: BinanceChainId | null;
  tokenContractAddress?: string | null;
  platformId?: string | null;
  assetType?: RwaAssetType | number;
  statusInfo?: RwaStatusInfo;
  marketData?: RwaUnderlyingMarketData;
}

// ── GET /api/v1/dex/market/rwa/search ────────────────────────────────────────
export interface SearchRwaParams {
  /** Ticker, company name, or contract address. Case-insensitive. */
  keyword: string;
  platformId?: RwaPlatformId;
}
export interface RwaSearchResult {
  ticker?: string | null;
  companyName?: string | null;
  assets?: Array<{
    platformId?: string | null;
    binanceChainId?: BinanceChainId | null;
    tokenContractAddress?: string | null;
    tokenSymbol?: string | null;
    assetType?: RwaAssetType | number;
  }>;
}
