import { ENDPOINTS } from "../endpoints";
import type { BinanceHttpClient } from "../http";
import { ApproveTxSchema, BuildSwapSchema, QuoteSchema, RfqOrderSchema, SwapTxStatusSchema } from "../schemas";
import type { BinanceResult } from "../types/common";
import type {
  ApproveTxResponse,
  BuildSwapParams,
  BuildSwapResponse,
  GetApproveTxParams,
  GetQuoteParams,
  GetSwapStatusParams,
  QuoteResponse,
  RfqOrder,
  SwapTxStatusResponse,
} from "../types/trading";
import { TradingInputs, validate } from "../validation";

const boolParam = (v: boolean | undefined) => (v === undefined ? undefined : v ? "true" : "false");

/**
 * Trading (aggregator) API — read-only methods only.
 *
 * Trade execution (POST /aggregator/order/submit) is intentionally NOT
 * implemented in this phase. There is no method that submits an order.
 */
export class TradingApi {
  constructor(private readonly http: BinanceHttpClient) {}

  /** GET /aggregator/quote — all routes. Pass userWalletAddress for RFQ (equity) routes. */
  async quote(params: GetQuoteParams): Promise<BinanceResult<QuoteResponse>> {
    const p = validate(TradingInputs.quote, params, "trading.quote");
    return this.http.request(ENDPOINTS.quote, { query: p, schema: QuoteSchema });
  }

  /**
   * GET /aggregator/swap — BUILDS (never sends) the tx or RFQ typed data.
   * Nothing executes without a wallet signature + submit, which GapPilot does not do yet.
   */
  async buildSwap(params: BuildSwapParams): Promise<BinanceResult<BuildSwapResponse>> {
    const p = validate(TradingInputs.buildSwap, params, "trading.buildSwap");
    return this.http.request(ENDPOINTS.swap, {
      query: { ...p, autoSlippage: boolParam(p.autoSlippage), approveTransaction: boolParam(p.approveTransaction) },
      schema: BuildSwapSchema,
    });
  }

  /** GET /aggregator/approve-transaction — approve() calldata. For Ondo/bStocks pass `vendor`. */
  async approveTransaction(params: GetApproveTxParams): Promise<BinanceResult<ApproveTxResponse>> {
    const p = validate(TradingInputs.approve, params, "trading.approveTransaction");
    return this.http.request(ENDPOINTS.approveTransaction, { query: p, schema: ApproveTxSchema });
  }

  /** GET /aggregator/order/{orderId} — RFQ settlement status (read-only). */
  async rfqOrderStatus(orderId: string): Promise<BinanceResult<RfqOrder>> {
    const id = validate(TradingInputs.orderId, orderId, "trading.rfqOrderStatus");
    return this.http.request(ENDPOINTS.rfqOrderStatus, { pathParams: { orderId: id }, schema: RfqOrderSchema });
  }

  /** GET /aggregator/history — on-chain swap status; data is null when not found. */
  async swapTxStatus(params: GetSwapStatusParams): Promise<BinanceResult<SwapTxStatusResponse>> {
    const p = validate(TradingInputs.swapStatus, params, "trading.swapTxStatus");
    return this.http.request(ENDPOINTS.swapTxStatus, { query: p, schema: SwapTxStatusSchema });
  }
}
