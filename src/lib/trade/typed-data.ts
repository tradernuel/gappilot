/**
 * Inspection of RFQ typed data (EIP-712) returned by /aggregator/swap.
 * The Transaction API cannot simulate an off-chain signed order, so this is
 * the verification for that step. Vendors use different field names, so we
 * look for well-known ones and report what we could and couldn't confirm.
 */
import { sameAddress } from "./calldata";
import type { TypedDataReview } from "./types";

const RECEIVER_FIELDS = ["receiver", "recipient", "to", "beneficiary"];
const OWNER_FIELDS = ["owner", "maker", "from", "signer", "user", "trader"];
const SELL_FIELDS = ["sellAmount", "makingAmount", "amountIn", "inputAmount", "srcAmount", "fromAmount"];
const BUY_FIELDS = ["buyAmount", "takingAmount", "amountOutMin", "minAmountOut", "outputAmount", "dstAmount", "toAmount"];
const DEADLINE_FIELDS = ["validTo", "deadline", "expiry", "expiration", "expiresAt"];
const ZERO = "0x0000000000000000000000000000000000000000";

function findField(obj: Record<string, unknown>, names: string[]): [string, unknown] | null {
  for (const n of names) {
    const key = Object.keys(obj).find((k) => k.toLowerCase() === n.toLowerCase());
    if (key !== undefined) return [key, obj[key]];
  }
  return null;
}

const asBigIntString = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return v;
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v).toString();
  return null;
};

export function inspectTypedData(
  raw: string | null | undefined,
  ctx: { wallet: string; sellAmountRaw: string; minBuyAmountRaw: bigint; now: number },
): TypedDataReview {
  const review: TypedDataReview = {
    decodable: false, primaryType: null, domainName: null, chainId: null, receiver: null,
    sellAmountRaw: null, buyAmountRaw: null, deadline: null, checks: [],
  };
  const check = (c: string, passed: boolean, detail: string) => review.checks.push({ check: c, passed, detail });

  let parsed: { domain?: Record<string, unknown>; primaryType?: unknown; message?: Record<string, unknown> } | null = null;
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : null;
    if (j && typeof j === "object" && j.message && typeof j.message === "object") parsed = j;
  } catch {
    parsed = null;
  }
  if (!parsed?.message) {
    check("DECODE", false, raw ? "The order is hex-encoded or not JSON typed data, so its contents can't be verified." : "No typed data was returned.");
    return review;
  }
  review.decodable = true;
  const m = parsed.message;
  review.primaryType = typeof parsed.primaryType === "string" ? parsed.primaryType : null;
  review.domainName = typeof parsed.domain?.name === "string" ? parsed.domain.name : null;
  const chain = parsed.domain?.chainId;
  review.chainId = typeof chain === "number" ? chain : typeof chain === "string" && /^\d+$/.test(chain) ? Number(chain) : null;

  check("CHAIN", review.chainId === null || review.chainId === 56, review.chainId === null ? "No chainId in the domain." : `Domain chainId ${review.chainId}${review.chainId === 56 ? " (BSC)" : ", not BSC"}.`);

  const receiver = findField(m, RECEIVER_FIELDS);
  const owner = findField(m, OWNER_FIELDS);
  if (receiver && typeof receiver[1] === "string") {
    review.receiver = receiver[1];
    const ok = sameAddress(receiver[1], ctx.wallet) || sameAddress(receiver[1], ZERO);
    check("RECEIVER", ok, ok ? "Proceeds go to your wallet." : `The order sends proceeds to ${receiver[1]}, not your wallet.`);
  } else if (owner && typeof owner[1] === "string") {
    const ok = sameAddress(owner[1], ctx.wallet);
    check("OWNER", ok, ok ? "The order is from your wallet (no separate receiver field)." : `The order's ${owner[0]} is ${owner[1]}, not your wallet.`);
  } else {
    check("RECEIVER", false, "Couldn't find a receiver or owner field to confirm the order pays your wallet.");
  }

  const sell = findField(m, SELL_FIELDS);
  review.sellAmountRaw = sell ? asBigIntString(sell[1]) : null;
  if (review.sellAmountRaw === null) check("SELL_AMOUNT", false, "Couldn't find the amount you'd send in the order.");
  else check("SELL_AMOUNT", review.sellAmountRaw === ctx.sellAmountRaw, review.sellAmountRaw === ctx.sellAmountRaw ? "Amount sent matches the quote." : "The order sends a different amount than the quote.");

  const buy = findField(m, BUY_FIELDS);
  review.buyAmountRaw = buy ? asBigIntString(buy[1]) : null;
  if (review.buyAmountRaw === null) check("BUY_AMOUNT", false, "Couldn't find the amount you'd receive in the order.");
  else {
    const ok = BigInt(review.buyAmountRaw) >= ctx.minBuyAmountRaw;
    check("BUY_AMOUNT", ok, ok ? "Amount received is at or above your slippage floor." : "Amount received is below your slippage floor.");
  }

  const dl = findField(m, DEADLINE_FIELDS);
  if (dl) {
    const v = Number(asBigIntString(dl[1]) ?? NaN);
    const ms = v > 1e12 ? v : v * 1000;
    review.deadline = Number.isFinite(ms) ? ms : null;
    const ok = review.deadline !== null && review.deadline > ctx.now && review.deadline - ctx.now <= 3_600_000;
    check("DEADLINE", ok, ok ? "The order expires within the hour." : "The order's deadline is missing, past, or more than an hour away.");
  }
  return review;
}
