/**
 * Rule-based parser: produces the same Extraction shape as the LLM parser.
 * Used when no LLM is configured (or it fails). Covers common phrasings;
 * anything it can't read stays null and the compiler reports what's missing.
 */
import { extractNumbers } from "./text";
import type { Extraction } from "./schema";

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(k|m|bn|b|thousand|million|billion)?`;

function toNumber(m: RegExpMatchArray, i: number): number {
  const base = Number(`${m[i]!.replace(/,/g, "")}${m[i + 1] ? `.${m[i + 1]}` : ""}`);
  const u = (m[i + 2] ?? "").toLowerCase();
  return base * (u === "k" || u === "thousand" ? 1e3 : u === "m" || u === "million" ? 1e6 : u === "b" || u === "bn" || u === "billion" ? 1e9 : 1);
}

const TICKER_STOPLIST = new Set(["I", "A", "USD", "USDT", "BUY", "SELL", "AND", "OR", "THE", "WHEN", "ONLY", "MAX", "MIN", "BSC", "BNB", "US", "AM", "PM", "UTC", "ETF", "OK", "IF", "AT", "PER"]);

export function parseWithRules(text: string): Extraction {
  const t = text.trim();
  const lower = t.toLowerCase();
  const quotes: Extraction["quotes"] = { spread: null, liquidity: null, maximumTrade: null, slippage: null };

  // Action
  const buys = /\b(?:buy|purchase|accumulate)\b/i.test(t);
  const sells = /\bsell\b/i.test(t);
  const action: Extraction["action"] = buys && !sells ? "BUY" : sells && !buys ? "SELL" : null;

  // Spread threshold
  let spread: number | null = null;
  const below = t.match(new RegExp(String.raw`${NUM}\s*(?:%|percent|pct)\s*(?:or more\s+)?(?:below|under|beneath|less than|cheaper than|discount)`, "i"))
    ?? t.match(new RegExp(String.raw`discount\s*(?:of|>=|≥|at least|of at least)?\s*${NUM}\s*(?:%|percent)`, "i"));
  const above = t.match(new RegExp(String.raw`${NUM}\s*(?:%|percent|pct)\s*(?:or more\s+)?(?:above|over|more than|premium)`, "i"))
    ?? t.match(new RegExp(String.raw`premium\s*(?:of|>=|≥|at least|of at least)?\s*${NUM}\s*(?:%|percent)`, "i"));
  if (below && !above) { spread = -toNumber(below, 1); quotes.spread = below[0]; }
  else if (above && !below) { spread = toNumber(above, 1); quotes.spread = above[0]; }

  // Liquidity
  let liquidity: number | null = null;
  const liq = t.match(new RegExp(String.raw`liquidity\s*(?:is\s*|of\s*)?(?:above|over|at least|>=|≥|greater than|more than|exceeds|>)?\s*\$?\s*${NUM}`, "i"))
    ?? t.match(new RegExp(String.raw`\$\s*${NUM}\s*(?:\+|or more)?\s*(?:of\s+)?liquidity`, "i"));
  if (liq) { liquidity = toNumber(liq, 1); quotes.liquidity = liq[0]; }

  // Max trade size: "$50 per trade", "max $50 per trade", "trades of at most $50", "max trade $50"
  let maxTrade: number | null = null;
  const trade =
    t.match(new RegExp(String.raw`\$\s*${NUM}\s*(?:usd\s*)?(?:per|a|each|for each)\s+(?:trade|order|buy|sell)`, "i")) ??
    t.match(new RegExp(String.raw`(?:max(?:imum)?|at most|up to|no more than|limit(?:ed)? to|cap(?:ped)? at)\s*(?:trade\s*(?:size)?\s*(?:of|is|=|:)?\s*)?\$\s*${NUM}`, "i")) ??
    t.match(new RegExp(String.raw`(?:max(?:imum)?\s+)?trade\s*(?:size)?\s*(?:of|is|=|:|<=|≤)\s*\$?\s*${NUM}`, "i"));
  if (trade) { maxTrade = toNumber(trade, 1); quotes.maximumTrade = trade[0]; }

  // Slippage
  let slippage: number | null = null;
  const slip = t.match(new RegExp(String.raw`slippage\s*(?:of|below|under|at most|max(?:imum)?|<=|≤|<|no more than|up to|limit(?:ed)? to)?\s*${NUM}\s*(?:%|percent)`, "i"))
    ?? t.match(new RegExp(String.raw`${NUM}\s*(?:%|percent)\s*(?:max(?:imum)?\s*)?slippage`, "i"));
  if (slip) { slippage = toNumber(slip, 1); quotes.slippage = slip[0]; }

  // Market hours
  let market: Extraction["marketStatus"] = null;
  if (/\b(?:market hours|market is open|when (?:the )?market(?:s)? (?:is |are )?open|during (?:regular|trading) hours)\b/i.test(t)) market = "OPEN_ONLY";
  else if (/\b(?:market is closed|when (?:the )?market(?:s)? (?:is |are )?closed|weekends?|after[- ]hours|off[- ]hours|overnight)\b/i.test(t)) market = "CLOSED_ONLY";
  else if (/\b(?:any ?time|24\/7|around the clock)\b/i.test(t)) market = "ANY";

  // Asset scope
  const issuers = [...new Set([...(lower.match(/\bbstocks?\b/g) ? ["bstock"] : []), ...(lower.match(/\bondo\b/g) ? ["ondo"] : [])])];
  const tickers = [...new Set((t.match(/\b[A-Z][A-Z0-9]{1,5}\b/g) ?? []).filter((w) => !TICKER_STOPLIST.has(w)))];
  let scope: Extraction["assetScope"] = { type: "NONE", tickers: [], issuers: [] };
  if (tickers.length) scope = { type: "TICKERS", tickers, issuers: [] };
  else if (/\b(?:tokeni[sz]ed (?:stocks?|equities|shares)|(?:all|any|every) (?:stocks?|assets?|tokens?|equities)|stocks|equities)\b/i.test(t)) scope = { type: "ALL", tickers: [], issuers: [] };
  else if (issuers.length) scope = { type: "ISSUERS", tickers: [], issuers };

  const ambiguities: string[] = [];
  const dollarCount = extractNumbers(t).filter((n) => n.dollar).length;
  if (!trade && dollarCount > (liq ? 1 : 0)) ambiguities.push("A dollar amount is present but it's unclear whether it's the trade size.");

  return {
    action,
    unsupportedAction: null,
    assetScope: scope,
    spreadThresholdPercent: spread,
    minimumLiquidityUsd: liquidity,
    maximumTradeUsd: maxTrade,
    maximumSlippagePercent: slippage,
    marketStatus: market,
    requireSimulation: null,
    flags: { leverage: false, derivatives: false, short: false, autoExecute: false },
    ambiguities,
    quotes,
  };
}
