/**
 * BinanceAgenticWalletProvider — LIVE execution through the Binance Agentic
 * Wallet CLI (`baw`, @binance/agentic-wallet).
 *
 * STATUS: implemented against the CLI's documented commands (README) and the
 * JSON shapes its own code emits (v1.10.0). NOT verified against a live
 * session. Off by default; refuses to run on serverless hosts.
 *
 * Contract used (all via `--json`, success = {"success":true,"data":…}):
 *   baw --version                                   → "1.10.0"
 *   baw wallet status                               → { status: CONNECTED|UNCONNECTED|CREATING }
 *   baw wallet address                              → { addresses: [{ binanceChainId, chainName, address }] }
 *   baw wallet tx-lock --binanceChainId 56          → { status: LOCKED|… }
 *   baw wallet left-quota                           → { quotaUsed, quotaLeft, dailyLimit, date }
 *   baw market-order quote  --binanceChainId 56 --fromToken --toToken --fromTokenQty --slippage
 *                                                   → { fromCoinAmount, toCoinAmount, slippage (fraction), … }
 *   baw market-order swap   (same + --mev true --gasLevel MEDIUM) → { orderId }
 *   baw market-order list --orderId <id>            → { list: [{ orderId, status, txHash, toTokenActualQty, … }] }
 *
 * IMPORTANT LIMITATION: `baw` routes and builds its own transaction. It can't
 * execute the exact transaction GapPilot simulated through the Transaction API,
 * and its JSON quote omits the quote ID. Compensating controls, all enforced here:
 *   1. GapPilot's Transaction API simulation must have PASSED (policy).
 *   2. baw's own quote must meet the simulated minimum output, within the slippage limit.
 *   3. The swap is sent with --slippage = the user's limit (never "auto").
 *   4. After settlement, the actual output is compared with the minimum; a shortfall
 *      is recorded as FILLED_BELOW_MINIMUM.
 */
import { execFile } from "node:child_process";
import { assertProof } from "./policy";
import { decimalStringToRaw, rawToDecimalString } from "./units";
import type { AuthorizationProof, ExecutionProvider, ExecutionRequest, ExecutionResult, ProviderPreflight } from "./types";

export type CliRunner = (args: string[]) => Promise<{ stdout: string; exitCode: number }>;

export function nodeCliRunner(cliPath: string, timeoutMs = 60_000): CliRunner {
  return (args) =>
    new Promise((resolve) => {
      // execFile: no shell, arguments passed as an array (no injection surface).
      execFile(cliPath, args, { timeout: timeoutMs, maxBuffer: 1_000_000, shell: false, windowsHide: true }, (err, stdout) => {
        const code = err && typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : err ? 1 : 0;
        resolve({ stdout: String(stdout ?? ""), exitCode: code });
      });
    });
}

export class AgenticWalletError extends Error {
  constructor(readonly step: string, message: string) {
    super(`${step}: ${message}`);
    this.name = "AgenticWalletError";
  }
}

const EVM = /^0x[0-9a-fA-F]{40}$/;
const TXHASH = /^0x[0-9a-fA-F]{64}$/;

export interface AgenticProviderOptions {
  run: CliRunner;
  /** Required CLI version prefix, e.g. "1.10." — other versions are refused (contract may differ). */
  versionPrefix: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Set by hosts like Vercel. The provider refuses to run there (no keychain session). */
  isServerless?: boolean;
}

export class BinanceAgenticWalletProvider implements ExecutionProvider {
  readonly id = "binance-agentic-wallet" as const;
  readonly mode = "LIVE" as const;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: AgenticProviderOptions) {
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Runs `baw <args> --json` and returns `data`, or throws with the CLI's error message. */
  private async json(step: string, args: string[]): Promise<Record<string, unknown>> {
    const { stdout, exitCode } = await this.o.run([...args, "--json"]);
    let parsed: { success?: boolean; data?: unknown; error?: { message?: string; name?: string } };
    try {
      parsed = JSON.parse(stdout.trim().split("\n").filter((l) => l.trim()).join("\n"));
    } catch {
      throw new AgenticWalletError(step, `unexpected non-JSON output (exit ${exitCode})`);
    }
    if (exitCode !== 0 || parsed.success !== true) {
      throw new AgenticWalletError(step, parsed.error?.message ?? parsed.error?.name ?? `failed (exit ${exitCode})`);
    }
    if (!parsed.data || typeof parsed.data !== "object") throw new AgenticWalletError(step, "missing data");
    return parsed.data as Record<string, unknown>;
  }

  async preflight(request?: ExecutionRequest): Promise<ProviderPreflight> {
    const fail = (detail: string): ProviderPreflight => ({ ready: false, wallet: null, quotaLeftUsd: null, detail });
    if (this.o.isServerless) return fail("Binance Agentic Wallet runs only in the local agent worker (it needs your signed-in desktop session).");
    try {
      const v = await this.o.run(["--version"]);
      const version = v.stdout.trim();
      if (v.exitCode !== 0 && !version) return fail("The baw CLI isn't installed or can't run. Install it with `npm i -g @binance/agentic-wallet`, then `baw auth signin`.");
      if (v.exitCode !== 0 || !version.startsWith(this.o.versionPrefix)) {
        return fail(`baw CLI version ${version || "unknown"} isn't the verified ${this.o.versionPrefix}x; refusing (its output contract may differ).`);
      }
      const status = await this.json("wallet status", ["wallet", "status"]);
      if (status.status !== "CONNECTED") return fail(`Agentic Wallet is ${String(status.status ?? "not connected")}. Run \`baw auth signin\`.`);

      const addr = await this.json("wallet address", ["wallet", "address"]);
      const list = Array.isArray(addr.addresses) ? (addr.addresses as Array<Record<string, unknown>>) : [];
      const bsc = list.find((a) => String(a.binanceChainId) === "56");
      const wallet = typeof bsc?.address === "string" && EVM.test(bsc.address) ? bsc.address : null;
      if (!wallet) return fail("No BSC address in the Agentic Wallet.");

      const lock = await this.json("wallet tx-lock", ["wallet", "tx-lock", "--binanceChainId", "56"]);
      if (lock.status !== "UNLOCKED") return { ready: false, wallet, quotaLeftUsd: null, detail: `Transaction lock is ${String(lock.status)}; another transaction is in progress.` };

      const quota = await this.json("wallet left-quota", ["wallet", "left-quota"]);
      const quotaLeftUsd = typeof quota.quotaLeft === "number" && Number.isFinite(quota.quotaLeft) ? quota.quotaLeft : null;
      if (quotaLeftUsd === null) return { ready: false, wallet, quotaLeftUsd: null, detail: "Couldn't read the daily quota set in the Binance App." };

      if (request && request.wallet.toLowerCase() !== wallet.toLowerCase()) {
        return { ready: false, wallet, quotaLeftUsd, detail: "The simulated wallet isn't the Agentic Wallet's BSC address." };
      }
      return { ready: true, wallet, quotaLeftUsd, detail: `baw ${version}, connected, unlocked, $${quotaLeftUsd.toFixed(2)} quota left.` };
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
  }

  async execute(request: ExecutionRequest, proof: AuthorizationProof): Promise<ExecutionResult> {
    assertProof(request, proof, this.now());
    const fail = (detail: string, orderId: string | null = null): ExecutionResult => ({
      mode: "LIVE", provider: this.id, status: "FAILED", orderId, txHash: null, actualOutputRaw: null, detail,
    });

    // Re-run preflight against THIS request (wallet, lock, quota) right before acting.
    const pre = await this.preflight(request);
    if (!pre.ready) return fail(`Preflight: ${pre.detail}`);
    if (request.input.usd !== null && pre.quotaLeftUsd !== null && request.input.usd > pre.quotaLeftUsd) return fail("Daily quota set in the Binance App is too low for this trade.");

    const qty = rawToDecimalString(request.input.raw, request.input.decimals);
    const slippage = String(request.slippageLimitPercent); // never "auto"
    const base = ["--binanceChainId", "56", "--fromToken", request.input.address, "--toToken", request.output.address, "--fromTokenQty", qty, "--slippage", slippage];
    const minimum = BigInt(request.output.minimumRaw);

    // 2. baw's own route must meet the simulated minimum.
    try {
      const q = await this.json("market-order quote", ["market-order", "quote", ...base]);
      const toRaw = typeof q.toCoinAmount === "string" || typeof q.toCoinAmount === "number" ? decimalStringToRaw(String(q.toCoinAmount), request.output.decimals) : null;
      if (toRaw === null) return fail("baw quote had no readable output amount.");
      if (toRaw < minimum) return fail(`baw's route quotes ${String(q.toCoinAmount)} ${request.output.symbol}, below the simulated minimum ${rawToDecimalString(request.output.minimumRaw, request.output.decimals)}.`);
      if (typeof q.slippage === "number" && q.slippage * 100 > request.slippageLimitPercent + 1e-9) return fail(`baw applied ${(q.slippage * 100).toFixed(2)}% slippage, above the ${slippage}% limit.`);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    if (this.now() > request.expiresAt) return fail("The authorization expired before submission.");

    // 3. Submit with the explicit slippage limit.
    let orderId: string;
    try {
      const s = await this.json("market-order swap", ["market-order", "swap", ...base, "--mev", "true", "--gasLevel", "MEDIUM"]);
      if (typeof s.orderId !== "string" || !s.orderId) return fail("baw returned no order ID.");
      orderId = s.orderId;
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }

    // 4. Poll for settlement, then verify the actual output.
    const deadline = this.now() + (this.o.pollTimeoutMs ?? 120_000);
    while (this.now() < deadline) {
      try {
        const l = await this.json("market-order list", ["market-order", "list", "--orderId", orderId]);
        const order = (Array.isArray(l.list) ? (l.list as Array<Record<string, unknown>>) : []).find((x) => x.orderId === orderId);
        if (order?.status === "FAILED") return fail("The order failed on Binance Agentic Wallet.", orderId);
        if (order?.status === "FINISHED") {
          const txHash = typeof order.txHash === "string" && TXHASH.test(order.txHash) ? order.txHash : null;
          const actual = order.toTokenActualQty != null ? decimalStringToRaw(String(order.toTokenActualQty), request.output.decimals) : null;
          const below = actual !== null && actual < minimum;
          return {
            mode: "LIVE",
            provider: this.id,
            status: below ? "FILLED_BELOW_MINIMUM" : "FILLED",
            orderId,
            txHash,
            actualOutputRaw: actual?.toString() ?? null,
            detail: below
              ? "Filled below the simulated minimum output. Review this trade."
              : txHash ? "Filled via Binance Agentic Wallet." : "Filled, but no transaction hash was reported.",
          };
        }
      } catch {
        /* transient: keep polling until the deadline */
      }
      await this.sleep(this.o.pollIntervalMs ?? 3_000);
    }
    return { mode: "LIVE", provider: this.id, status: "PENDING", orderId, txHash: null, actualOutputRaw: null, detail: "Submitted; settlement not confirmed before the polling deadline. Check `baw market-order list`." };
  }
}
