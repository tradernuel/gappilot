import { ENDPOINTS } from "../endpoints";
import type { BinanceHttpClient } from "../http";
import {
  RwaPlatformsSchema,
  RwaPriceSchema,
  RwaSearchSchema,
  RwaTokensSchema,
  RwaUnderlyingMarketSchema,
  RwaUnderlyingProfileSchema,
} from "../schemas";
import type { BinanceResult } from "../types/common";
import type {
  GetRwaPlatformsParams,
  GetRwaPriceParams,
  GetRwaTokensParams,
  RwaPlatform,
  RwaPrice,
  RwaSearchResult,
  RwaToken,
  RwaTokenParams,
  RwaUnderlyingMarket,
  RwaUnderlyingProfile,
  SearchRwaParams,
} from "../types/rwa";
import { RwaInputs, validate } from "../validation";

/** RWA Data API. Every method validates input before any network call. */
export class RwaApi {
  constructor(private readonly http: BinanceHttpClient) {}

  /** GET /rwa/platforms — issuers (ondo, bstock) and per-chain token counts. */
  async platforms(params: GetRwaPlatformsParams = {}): Promise<BinanceResult<RwaPlatform[]>> {
    const p = validate(RwaInputs.platforms, params, "rwa.platforms");
    return this.http.request(ENDPOINTS.rwaPlatforms, { query: p, schema: RwaPlatformsSchema });
  }

  /** GET /rwa/tokens — discovery: token list with price, ratio, status, volume. */
  async tokens(params: GetRwaTokensParams = {}): Promise<BinanceResult<RwaToken[]>> {
    const p = validate(RwaInputs.tokens, params, "rwa.tokens");
    return this.http.request(ENDPOINTS.rwaTokens, { query: p, schema: RwaTokensSchema });
  }

  /** GET /rwa/price — batch (≤100) on-chain prices with tokenPriceUpdatedAt. */
  async price(params: GetRwaPriceParams): Promise<BinanceResult<RwaPrice[]>> {
    const p = validate(RwaInputs.price, params, "rwa.price");
    return this.http.request(ENDPOINTS.rwaPrice, {
      query: { binanceChainId: p.binanceChainId, tokenContractAddresses: p.tokenContractAddresses.join(",") },
      schema: RwaPriceSchema,
    });
  }

  /** GET /rwa/underlying-profile — token-to-share ratio, attestations, company info. */
  async underlyingProfile(params: RwaTokenParams): Promise<BinanceResult<RwaUnderlyingProfile>> {
    const p = validate(RwaInputs.token, params, "rwa.underlyingProfile");
    return this.http.request(ENDPOINTS.rwaUnderlyingProfile, { query: p, schema: RwaUnderlyingProfileSchema });
  }

  /** GET /rwa/underlying-market — market status (open/closed/paused + reason) and stats. */
  async underlyingMarket(params: RwaTokenParams): Promise<BinanceResult<RwaUnderlyingMarket>> {
    const p = validate(RwaInputs.token, params, "rwa.underlyingMarket");
    return this.http.request(ENDPOINTS.rwaUnderlyingMarket, { query: p, schema: RwaUnderlyingMarketSchema });
  }

  /** GET /rwa/search — every issuer's token for one ticker / name / address. */
  async search(params: SearchRwaParams): Promise<BinanceResult<RwaSearchResult[]>> {
    const p = validate(RwaInputs.search, params, "rwa.search");
    return this.http.request(ENDPOINTS.rwaSearch, { query: p, schema: RwaSearchSchema });
  }
}
