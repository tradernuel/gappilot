/** Display lines for a strategy ("YOUR RULE" card). Pure; shared by UI and tests. */
import type { CompileResult, Strategy } from "./schema";

export interface RuleLine {
  label: string;
  value: string;
  isDefault?: boolean;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export function describeStrategy(s: Strategy, defaults: CompileResult["defaultsApplied"] = []): { headline: string; lines: RuleLine[]; name: string } {
  const m = Math.abs(s.spreadThresholdPercent);
  const when =
    s.action === "BUY"
      ? `Spread ≤ −${m.toFixed(2)}% (at least ${m}% below reference)`
      : `Spread ≥ +${m.toFixed(2)}% (at least ${m}% above reference)`;
  const scope =
    s.assetScope.type === "ALL" ? "All tokenized stocks" : s.assetScope.type === "TICKERS" ? s.assetScope.tickers.join(", ") : s.assetScope.issuers.map((i) => (i === "bstock" ? "bStocks" : "Ondo")).join(", ");
  const market = { ANY: "Any time", OPEN_ONLY: "Only while the US market is open", CLOSED_ONLY: "Only while the US market is closed" }[s.marketStatus];
  return {
    headline: s.action,
    name: `${s.action === "BUY" ? "Buy" : "Sell"} ${scope === "All tokenized stocks" ? "" : `${scope} `}at ${m}% ${s.action === "BUY" ? "discount" : "premium"}, max ${usd(s.maximumTradeUsd)}`,
    lines: [
      { label: "Assets", value: scope },
      { label: "When", value: when },
      { label: "Liquidity", value: `≥ ${usd(s.minimumLiquidityUsd)}`, isDefault: defaults.includes("minimumLiquidityUsd") },
      { label: "Max trade", value: `${usd(s.maximumTradeUsd)} per trade` },
      { label: "Max slippage", value: `${s.maximumSlippagePercent.toFixed(2)}%`, isDefault: defaults.includes("maximumSlippagePercent") },
      { label: "Market hours", value: market, isDefault: defaults.includes("marketStatus") },
      { label: "Simulation", value: "Required" },
    ],
  };
}
