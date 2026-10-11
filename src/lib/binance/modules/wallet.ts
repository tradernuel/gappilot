import { ENDPOINTS } from "../endpoints";
import type { BinanceHttpClient } from "../http";
import { AllBalancesSchema, TokenBalancesSchema, TxDetailSchema } from "../schemas";
import type { BinanceResult } from "../types/common";
import type { TxDetailParams, TxDetailResponse } from "../types/transaction";
import type {
  AllBalancesResponse,
  GetAllBalancesParams,
  GetTokenBalancesParams,
  TokenBalancesResponse,
} from "../types/wallet";
import { validate, WalletInputs } from "../validation";

/** Wallet API — read-only balance and tx lookups for any address. Holds no keys. */
export class WalletApi {
  constructor(private readonly http: BinanceHttpClient) {}

  /** GET /balance/all-token-balances-by-address — one chain per call (spec). */
  async allTokenBalances(params: GetAllBalancesParams): Promise<BinanceResult<AllBalancesResponse>> {
    const p = validate(WalletInputs.allBalances, params, "wallet.allTokenBalances");
    return this.http.request(ENDPOINTS.allTokenBalances, { query: p, schema: AllBalancesSchema });
  }

  /** POST /balance/token-balances-by-address — specific tokens, up to 20. */
  async tokenBalances(params: GetTokenBalancesParams): Promise<BinanceResult<TokenBalancesResponse>> {
    const p = validate(WalletInputs.tokenBalances, params, "wallet.tokenBalances");
    return this.http.request(ENDPOINTS.tokenBalances, { body: p, schema: TokenBalancesSchema });
  }

  /** GET /post-transaction/transaction-detail-by-txhash — tx detail incl. token transfers. */
  async txDetail(params: TxDetailParams): Promise<BinanceResult<TxDetailResponse>> {
    const p = validate(WalletInputs.txDetail, params, "wallet.txDetail");
    return this.http.request(ENDPOINTS.txDetailByHash, { query: p, schema: TxDetailSchema });
  }
}
