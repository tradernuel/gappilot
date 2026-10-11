import "server-only";
import { z } from "zod";

/**
 * Server-side environment, validated once and cached.
 *
 * Secrets live only here. Nothing in this module may be re-exported to client
 * components; `server-only` makes the build fail if that ever happens.
 */

const evmAddress = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed 20-byte hex address");

const boolFromString = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const EnvSchema = z.object({
  BINANCE_WEB3_API_KEY: z.string().min(1, "BINANCE_WEB3_API_KEY is required"),
  BINANCE_WEB3_API_SECRET: z.string().min(1, "BINANCE_WEB3_API_SECRET is required"),
  BINANCE_WEB3_BASE_URL: z.string().url().default("https://web3.binance.com/build"),
  BINANCE_WEB3_RECV_WINDOW_MS: z.coerce.number().int().min(1).max(60_000).default(5_000),
  BINANCE_WEB3_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(10_000),

  GAPPILOT_QUOTE_TOKEN_ADDRESS: evmAddress,

  GAPPILOT_MAX_TOKEN_PRICE_AGE_MS: z.coerce.number().int().positive().default(120_000),
  GAPPILOT_MIN_NET_EDGE_BPS: z.coerce.number().nonnegative().default(50),
  GAPPILOT_MIN_LIQUIDITY_USD: z.coerce.number().nonnegative().default(25_000),

  GAPPILOT_EXECUTION_ENABLED: boolFromString,
  /**
   * Which ExecutionProvider handles approved/authorized trades.
   *  - "mock" (default): SIMULATED execution; nothing is sent.
   *  - "binance-agentic-wallet": LIVE via the `baw` CLI. Local agent worker only,
   *    and only when GAPPILOT_EXECUTION_ENABLED=true.
   */
  GAPPILOT_EXECUTION_PROVIDER: z.enum(["mock", "binance-agentic-wallet"]).default("mock"),
  GAPPILOT_AGENTIC_CLI_PATH: z.string().min(1).default("baw"),
  /** The adapter's JSON contract was read from this CLI version; others are refused. */
  GAPPILOT_AGENTIC_CLI_VERSION_PREFIX: z.string().min(1).default("1.10."),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /**
   * Bearer token for the /api/binance/* integration routes in production.
   * Unset in production → those routes return 404 (they would otherwise be an
   * open proxy spending your API quota). Always enabled in development.
   */
  GAPPILOT_DEBUG_ROUTES_TOKEN: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(16, "use at least 16 characters").optional()),
  GAPPILOT_REFERENCE_PROVIDER: z.enum(["none"]).default("none"),

  // Optional until the explanation layer lands (phase 3).
  OPENAI_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  OPENAI_MODEL: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
});

export type ServerEnv = z.infer<typeof EnvSchema>;

let cached: ServerEnv | undefined;

export type EnvSource = Record<string, string | undefined>;

export function getServerEnv(source: EnvSource = process.env): ServerEnv {
  if (cached && source === process.env) return cached;
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid GapPilot environment:\n${details}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}

/** Fixed: the hackathon is BSC-mainnet only. Not configurable on purpose. */
export const BSC_CHAIN_ID = "56" as const;
