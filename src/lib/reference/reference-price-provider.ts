/** Independent per-share reference, e.g. the last official close. */
export interface ReferenceQuote {
  ticker: string;
  priceUsd: number;
  /** When the reference was observed (Unix ms), e.g. the official close time. */
  asOf: number;
  provider: string;
}

/**
 * Independent reference-price seam.
 *
 * WHY THIS EXISTS: the Binance RWA API's `referencePrice` is documented as
 * "a per-share converted price derived from the on-chain token price, not an
 * official quote from the traditional stock market". It therefore cannot
 * measure the gap between the token and the (stale) TradFi price.
 *
 * GapPilot's primary signal is CROSS_ISSUER divergence (bStocks vs Ondo for the
 * same ticker), which needs no external data. A TOKEN_VS_REFERENCE signal is
 * only produced when a real provider is configured here.
 *
 * Candidate (NOT implemented, NOT verified): Binance Stocks Trading API
 * `GET /sapi/v1/equity/market/quote` — a separate Binance product with separate
 * keys and its own region rules. Its parameters have not been inspected yet.
 */
export interface ReferencePriceProvider {
  readonly name: string;
  readonly isConfigured: boolean;
  /** Returns null when the provider has no data for the ticker. Never fabricates. */
  getQuote(ticker: string): Promise<ReferenceQuote | null>;
}

export class NoReferenceProvider implements ReferencePriceProvider {
  readonly name = "none";
  readonly isConfigured = false;
  async getQuote(): Promise<ReferenceQuote | null> {
    return null;
  }
}

export function createReferenceProvider(kind: "none"): ReferencePriceProvider {
  switch (kind) {
    case "none":
      return new NoReferenceProvider();
  }
}
