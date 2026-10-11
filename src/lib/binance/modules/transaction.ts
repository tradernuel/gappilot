import { ENDPOINTS } from "../endpoints";
import type { BinanceHttpClient } from "../http";
import { GasLimitSchema, GasPriceSchema, SimulationSchema } from "../schemas";
import type { BinanceChainId, BinanceResult } from "../types/common";
import type { GasLimit, GasLimitParams, GasPrice, SimulateParams, SimulationResult } from "../types/transaction";
import { TransactionInputs, validate } from "../validation";

/**
 * Transaction API — simulation and gas only.
 * POST /pre-transaction/broadcast-transaction is deliberately NOT exposed.
 */
export class TransactionApi {
  constructor(private readonly http: BinanceHttpClient) {}

  /** POST /pre-transaction/simulate — dry-run an EVM tx; nothing is broadcast. */
  async simulate(params: SimulateParams): Promise<BinanceResult<SimulationResult>> {
    const p = validate(TransactionInputs.simulate, params, "transaction.simulate");
    return this.http.request(ENDPOINTS.simulate, { body: p, schema: SimulationSchema });
  }

  /** GET /pre-transaction/gas-price */
  async gasPrice(binanceChainId: BinanceChainId): Promise<BinanceResult<GasPrice>> {
    const chain = validate(TransactionInputs.chain, binanceChainId, "transaction.gasPrice");
    return this.http.request(ENDPOINTS.gasPrice, { query: { binanceChainId: chain }, schema: GasPriceSchema });
  }

  /** POST /pre-transaction/gas-limit */
  async gasLimit(params: GasLimitParams): Promise<BinanceResult<GasLimit>> {
    const p = validate(TransactionInputs.gasLimit, params, "transaction.gasLimit");
    return this.http.request(ENDPOINTS.gasLimit, { body: p, schema: GasLimitSchema });
  }
}
