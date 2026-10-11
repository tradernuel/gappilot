import { BinanceHttpClient, type HttpClientConfig } from "./http";
import { MarketApi } from "./modules/market";
import { RwaApi } from "./modules/rwa";
import { TradingApi } from "./modules/trading";
import { TransactionApi } from "./modules/transaction";
import { WalletApi } from "./modules/wallet";

/**
 * Facade over the five Binance Web3 API families GapPilot uses.
 * Framework-agnostic so scripts and tests can use it. In the Next.js app, get
 * it via `getBinanceClient()` from ./client (server-only, env-wired).
 *
 * Read-only by construction: no method submits an order or broadcasts a tx.
 */
export class BinanceWeb3Client {
  readonly rwa: RwaApi;
  readonly market: MarketApi;
  readonly trading: TradingApi;
  readonly transaction: TransactionApi;
  readonly wallet: WalletApi;

  constructor(http: BinanceHttpClient) {
    this.rwa = new RwaApi(http);
    this.market = new MarketApi(http);
    this.trading = new TradingApi(http);
    this.transaction = new TransactionApi(http);
    this.wallet = new WalletApi(http);
  }

  static create(config: HttpClientConfig): BinanceWeb3Client {
    return new BinanceWeb3Client(new BinanceHttpClient(config));
  }
}
