import { ENDPOINTS } from "../endpoints";
import type { BinanceHttpClient } from "../http";
import { TokenBasicInfoSchema, TopLiquiditySchema } from "../schemas";
import type { BinanceResult } from "../types/common";
import type { LiquidityPool, TokenBasicInfo, TokenParams } from "../types/market";
import { MarketInputs, validate } from "../validation";

export class MarketApi {
  constructor(private readonly http: BinanceHttpClient) {}

  /** POST /market/token/basic-info — decimals, symbol. Params go in the QUERY string (per SDK). */
  async basicInfo(params: TokenParams): Promise<BinanceResult<TokenBasicInfo>> {
    const p = validate(MarketInputs.token, params, "market.basicInfo");
    return this.http.request(ENDPOINTS.tokenBasicInfo, { query: p, schema: TokenBasicInfoSchema });
  }

  /** GET /market/token/top-liquidity — DEX pools and USD liquidity for a token. */
  async topLiquidity(params: TokenParams): Promise<BinanceResult<LiquidityPool[]>> {
    const p = validate(MarketInputs.token, params, "market.topLiquidity");
    return this.http.request(ENDPOINTS.topLiquidity, { query: p, schema: TopLiquiditySchema });
  }

  /**
   * INTEGRATION POINT — POST /market/price and POST /market/price-info.
   *
   * Both are documented endpoints, but the official generated SDK sends an empty
   * body, so the request body format is not available in machine-readable form.
   * We refuse to guess it. GapPilot gets token prices from /rwa/price and
   * liquidity from /market/token/top-liquidity.
   */
  tokenPrice(): never {
    throw new Error(
      "market.tokenPrice is not wired: POST /api/v1/dex/market/price body shape is undocumented. See docs/binance-api-findings.md.",
    );
  }

  tokenTradingInfo(): never {
    throw new Error(
      "market.tokenTradingInfo is not wired: POST /api/v1/dex/market/price-info body shape is undocumented. See docs/binance-api-findings.md.",
    );
  }
}
