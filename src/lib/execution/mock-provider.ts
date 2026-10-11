/**
 * MockExecutionProvider — SIMULATED execution.
 *
 * Nothing leaves GapPilot: no wallet, no RPC, no Binance order. It returns a
 * deterministic "fill" at the expected output so the full autonomous pipeline
 * (authorization → execution → audit) can be demonstrated safely.
 * Its hashes are "SIMULATED-<id>" and can never be mistaken for a 0x tx hash.
 */
import { assertProof } from "./policy";
import type { AuthorizationProof, ExecutionProvider, ExecutionRequest, ExecutionResult, ProviderPreflight } from "./types";

export class MockExecutionProvider implements ExecutionProvider {
  readonly id = "mock" as const;
  readonly mode = "SIMULATED" as const;

  constructor(
    private readonly opts: { wallet?: string | null; now?: () => number; failWith?: string } = {},
  ) {}

  async preflight(request?: ExecutionRequest): Promise<ProviderPreflight> {
    return {
      ready: true,
      // The mock acts "as" whichever wallet was simulated; it holds no keys.
      wallet: this.opts.wallet ?? request?.wallet ?? null,
      quotaLeftUsd: null,
      detail: "Simulated execution: no transaction is created or sent.",
    };
  }

  async execute(request: ExecutionRequest, proof: AuthorizationProof): Promise<ExecutionResult> {
    assertProof(request, proof, (this.opts.now ?? Date.now)());
    if (this.opts.failWith) {
      return { mode: "SIMULATED", provider: "mock", status: "FAILED", orderId: null, txHash: null, actualOutputRaw: null, detail: `Simulated failure: ${this.opts.failWith}` };
    }
    return {
      mode: "SIMULATED",
      provider: "mock",
      status: "FILLED",
      orderId: `SIM-ORDER-${request.requestId.slice(0, 8)}`,
      txHash: `SIMULATED-${request.requestId}`,
      actualOutputRaw: request.output.expectedRaw,
      detail: "Simulated execution: filled at the quoted output. No transaction was created or sent.",
    };
  }
}
