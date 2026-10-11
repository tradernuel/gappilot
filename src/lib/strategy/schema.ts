/**
 * Strategy schema — the ONLY shape a strategy can take once compiled.
 * Strict: unknown keys are rejected, and safety-critical fields are pinned.
 * There is no field for addresses, calldata, gas, approvals, leverage or
 * auto-execution, so a strategy cannot express them.
 */
import { z } from "zod";

/** Safety caps. Strategies may be stricter, never looser. */
export const STRATEGY_LIMITS = {
  /** Smallest |spread| a strategy may target; below this it's noise (engine: 25 bps). */
  minSpreadPercent: 0.25,
  maxSpreadPercent: 25,
  /** Engine liquidity floor. */
  minLiquidityUsd: 25_000,
  maxLiquidityUsd: 10_000_000_000,
  /** Hard per-trade cap while execution is unbuilt. */
  maxTradeUsd: 10_000,
  /** Above this, slippage is treated as an unsafe transaction parameter. */
  maxSlippagePercent: 2,
  defaultSlippagePercent: 0.5,
  maxTextLength: 500,
} as const;

export const ISSUERS = ["bstock", "ondo"] as const;

export const AssetScopeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ALL") }).strict(),
  z.object({ type: z.literal("TICKERS"), tickers: z.array(z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/)).min(1).max(20) }).strict(),
  z.object({ type: z.literal("ISSUERS"), issuers: z.array(z.enum(ISSUERS)).min(1).max(2) }).strict(),
]);
export type AssetScope = z.infer<typeof AssetScopeSchema>;

export const StrategySchema = z
  .object({
    version: z.literal(1),
    /** Spot only. SELL means selling tokens already held. */
    action: z.enum(["BUY", "SELL"]),
    assetScope: AssetScopeSchema,
    /** Signed: BUY targets a discount (≤ −0.25), SELL a premium (≥ +0.25). */
    spreadThresholdPercent: z.number().finite(),
    minimumLiquidityUsd: z.number().min(STRATEGY_LIMITS.minLiquidityUsd).max(STRATEGY_LIMITS.maxLiquidityUsd),
    maximumTradeUsd: z.number().positive().max(STRATEGY_LIMITS.maxTradeUsd),
    maximumSlippagePercent: z.number().positive().max(STRATEGY_LIMITS.maxSlippagePercent),
    marketStatus: z.enum(["ANY", "OPEN_ONLY", "CLOSED_ONLY"]),
    /** Pinned. A strategy can never skip simulation. */
    requireSimulation: z.literal(true),
    sourceText: z.string().min(1).max(STRATEGY_LIMITS.maxTextLength),
  })
  .strict()
  .superRefine((s, ctx) => {
    const m = Math.abs(s.spreadThresholdPercent);
    if (m < STRATEGY_LIMITS.minSpreadPercent || m > STRATEGY_LIMITS.maxSpreadPercent) {
      ctx.addIssue({ code: "custom", path: ["spreadThresholdPercent"], message: `|spread| must be between ${STRATEGY_LIMITS.minSpreadPercent}% and ${STRATEGY_LIMITS.maxSpreadPercent}%` });
    }
    if (s.action === "BUY" && s.spreadThresholdPercent > 0) ctx.addIssue({ code: "custom", path: ["spreadThresholdPercent"], message: "BUY must target a discount (negative spread)" });
    if (s.action === "SELL" && s.spreadThresholdPercent < 0) ctx.addIssue({ code: "custom", path: ["spreadThresholdPercent"], message: "SELL must target a premium (positive spread)" });
    if (s.maximumSlippagePercent >= m) ctx.addIssue({ code: "custom", path: ["maximumSlippagePercent"], message: "slippage limit must be below the spread threshold" });
  });
export type Strategy = z.infer<typeof StrategySchema>;

export const SavedStrategySchema = z
  .object({
    id: z.string().min(1).max(64),
    name: z.string().min(1).max(120),
    createdAt: z.number().int().positive(),
    strategy: StrategySchema,
  })
  .strict();
export type SavedStrategy = z.infer<typeof SavedStrategySchema>;

/**
 * What a parser (LLM or rule-based) returns. Raw and untrusted: the compiler
 * decides what becomes a Strategy. `null` = the user did not say.
 */
export const ExtractionSchema = z
  .object({
    action: z.enum(["BUY", "SELL", "UNSUPPORTED"]).nullable(),
    unsupportedAction: z.string().max(80).nullable(),
    assetScope: z
      .object({
        type: z.enum(["ALL", "TICKERS", "ISSUERS", "NONE"]),
        tickers: z.array(z.string().max(12)).max(20),
        issuers: z.array(z.string().max(20)).max(5),
      })
      .strict(),
    spreadThresholdPercent: z.number().finite().nullable(),
    minimumLiquidityUsd: z.number().finite().nullable(),
    maximumTradeUsd: z.number().finite().nullable(),
    maximumSlippagePercent: z.number().finite().nullable(),
    marketStatus: z.enum(["ANY", "OPEN_ONLY", "CLOSED_ONLY"]).nullable(),
    requireSimulation: z.boolean().nullable(),
    flags: z.object({ leverage: z.boolean(), derivatives: z.boolean(), short: z.boolean(), autoExecute: z.boolean() }).strict(),
    ambiguities: z.array(z.string().max(200)).max(10),
    quotes: z
      .object({
        spread: z.string().max(200).nullable(),
        liquidity: z.string().max(200).nullable(),
        maximumTrade: z.string().max(200).nullable(),
        slippage: z.string().max(200).nullable(),
      })
      .strict(),
  })
  .strict();
export type Extraction = z.infer<typeof ExtractionSchema>;

export type IssueCode =
  | "EMPTY"
  | "TOO_LONG"
  | "MISSING_ACTION"
  | "UNSUPPORTED_ACTION"
  | "CONFLICTING_INSTRUCTIONS"
  | "LEVERAGE_OR_DERIVATIVES"
  | "MISSING_ASSET_SCOPE"
  | "INVALID_ASSET_SCOPE"
  | "MISSING_TRADE_SIZE"
  | "AMBIGUOUS_TRADE_SIZE"
  | "MISSING_THRESHOLD"
  | "INVALID_THRESHOLD"
  | "UNSAFE_PARAMETER"
  | "UNGROUNDED_VALUE"
  | "PARSER_ERROR";

export interface Issue {
  code: IssueCode | "WARNING";
  field?: keyof Strategy | "text";
  message: string;
}

export interface CompileResult {
  ok: boolean;
  strategy: Strategy | null;
  errors: Issue[];
  warnings: Issue[];
  /** Fields filled from documented defaults because the text didn't specify them. */
  defaultsApplied: Array<"minimumLiquidityUsd" | "maximumSlippagePercent" | "marketStatus">;
  parser: "llm" | "rules";
  extraction: Extraction | null;
}
