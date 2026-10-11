/**
 * Single source of truth for every Binance Web3 API endpoint GapPilot touches.
 *
 * Provenance: @binance-web3/wallet@13.0.1 (official generated connector).
 * `status`:
 *   - "documented": path, method, params and response model are in the spec.
 *   - "ambiguous":  path is documented but something we need is not (see note).
 * All endpoints are signed (the SDK calls every one with isSigned: true).
 */

export type ApiModule = "rwa" | "market" | "trading" | "transaction" | "wallet";
export type HttpMethod = "GET" | "POST";

export interface EndpointSpec {
  method: HttpMethod;
  path: string;
  module: ApiModule;
  /** Where parameters go. Note: some POST endpoints take QUERY params. */
  paramsIn: "query" | "body" | "path+query";
  status: "documented" | "ambiguous";
  docAnchor: string;
  note?: string;
}

const DOCS = "https://web3.binance.com/en/dev-docs/catalog/web3-wallet/api/rest-api";

export const ENDPOINTS = {
  // ── RWA Data API ───────────────────────────────────────────────────────────
  rwaPlatforms: {
    method: "GET", path: "/api/v1/dex/market/rwa/platforms", module: "rwa",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/rwa-data#get-rwa-token-issuance-platforms`,
  },
  rwaTokens: {
    method: "GET", path: "/api/v1/dex/market/rwa/tokens", module: "rwa",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/rwa-data#get-rwa-token-list`,
  },
  rwaPrice: {
    method: "GET", path: "/api/v1/dex/market/rwa/price", module: "rwa",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/rwa-data#get-rwa-token-price`,
    note: "referencePrice is derived from the on-chain token price (not a TradFi quote).",
  },
  rwaUnderlyingProfile: {
    method: "GET", path: "/api/v1/dex/market/rwa/underlying-profile", module: "rwa",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/rwa-data#get-rwa-underlying-info`,
  },
  rwaUnderlyingMarket: {
    method: "GET", path: "/api/v1/dex/market/rwa/underlying-market", module: "rwa",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/rwa-data#get-rwa-underlying-market-data`,
  },
  rwaSearch: {
    method: "GET", path: "/api/v1/dex/market/rwa/search", module: "rwa",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/rwa-data#search-rwa-token`,
  },

  // ── Market API ─────────────────────────────────────────────────────────────
  tokenBasicInfo: {
    method: "POST", path: "/api/v1/dex/market/token/basic-info", module: "market",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/general-data#get-token-basic-info`,
    note: "POST with query-string params and no body, per the SDK.",
  },
  topLiquidity: {
    method: "GET", path: "/api/v1/dex/market/token/top-liquidity", module: "market",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/general-data#get-top-liquidity-pools`,
  },
  tokenPrice: {
    method: "POST", path: "/api/v1/dex/market/price", module: "market",
    paramsIn: "body", status: "ambiguous",
    docAnchor: `${DOCS}/general-data#get-token-price`,
    note: "Request body shape undocumented in the generated SDK (it sends {}). Not wired.",
  },
  tokenTradingInfo: {
    method: "POST", path: "/api/v1/dex/market/price-info", module: "market",
    paramsIn: "body", status: "ambiguous",
    docAnchor: `${DOCS}/general-data#get-token-trading-info`,
    note: "Request body shape undocumented in the generated SDK (it sends {}). Not wired.",
  },

  // ── Trading API ────────────────────────────────────────────────────────────
  quote: {
    method: "GET", path: "/api/v1/dex/aggregator/quote", module: "trading",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/trading-api#get-aggregated-quote`,
  },
  swap: {
    method: "GET", path: "/api/v1/dex/aggregator/swap", module: "trading",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/trading-api#build-swap-transaction`,
  },
  approveTransaction: {
    method: "GET", path: "/api/v1/dex/aggregator/approve-transaction", module: "trading",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/trading-api#get-erc20-approve-transaction`,
  },
  submitRfqOrder: {
    method: "POST", path: "/api/v1/dex/aggregator/order/submit", module: "trading",
    paramsIn: "body", status: "ambiguous",
    docAnchor: `${DOCS}/trading-api#submit-rfq-order`,
    note: "quoteId is described as rfq.orderId, but rfq has no documented orderId. Execution phase only.",
  },
  rfqOrderStatus: {
    method: "GET", path: "/api/v1/dex/aggregator/order/{orderId}", module: "trading",
    paramsIn: "path+query", status: "documented",
    docAnchor: `${DOCS}/trading-api#get-rfq-order-status`,
    note: "The SDK also puts orderId in a GET body; we send it only in the path.",
  },
  swapTxStatus: {
    method: "GET", path: "/api/v1/dex/aggregator/history", module: "trading",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/trading-api#get-transaction-status`,
  },

  // ── Transaction API ────────────────────────────────────────────────────────
  simulate: {
    method: "POST", path: "/api/v1/dex/pre-transaction/simulate", module: "transaction",
    paramsIn: "body", status: "documented",
    docAnchor: `${DOCS}/transaction-api#simulate-transactions`,
    note: "Simulates EVM txs. Whether it can meaningfully cover RFQ settlement is unconfirmed.",
  },
  gasPrice: {
    method: "GET", path: "/api/v1/dex/pre-transaction/gas-price", module: "transaction",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/transaction-api#get-gas-price`,
  },
  gasLimit: {
    method: "POST", path: "/api/v1/dex/pre-transaction/gas-limit", module: "transaction",
    paramsIn: "body", status: "documented",
    docAnchor: `${DOCS}/transaction-api#get-gas-limit`,
  },
  txDetailByHash: {
    method: "GET", path: "/api/v1/dex/post-transaction/transaction-detail-by-txhash", module: "wallet",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/wallet-api#get-transaction-detail-by-hash`,
    note: "Grouped under the Wallet API in the docs despite the post-transaction path.",
  },

  // ── Wallet (balance) API ───────────────────────────────────────────────────
  allTokenBalances: {
    method: "GET", path: "/api/v1/dex/balance/all-token-balances-by-address", module: "wallet",
    paramsIn: "query", status: "documented",
    docAnchor: `${DOCS}/wallet-api#get-all-token-balances-by-address`,
  },
  tokenBalances: {
    method: "POST", path: "/api/v1/dex/balance/token-balances-by-address", module: "wallet",
    paramsIn: "body", status: "documented",
    docAnchor: `${DOCS}/wallet-api#get-token-balances-by-address`,
  },
} as const satisfies Record<string, EndpointSpec>;

export type EndpointName = keyof typeof ENDPOINTS;
