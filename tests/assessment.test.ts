import { describe, expect, it, vi } from "vitest";
import { attest, verifyAttestation } from "../src/lib/assessment/attestation";
import { buildAssessmentFacts } from "../src/lib/assessment/facts";
import { allowedNumbers, validateAssessment } from "../src/lib/assessment/validate";
import { createResponse, OpenAiError } from "../src/lib/assessment/openai";
import { evaluateOpportunity } from "../src/lib/engine/evaluate";
import type { Opportunity } from "../src/lib/engine/types";

// Synthetic opportunity (not market data): $101 vs $100 per share, no quote, no wallet → WATCH.
const NOW = 1_800_000_000_000;
function opp(over: Partial<Parameters<typeof evaluateOpportunity>[0]> = {}): Opportunity {
  return evaluateOpportunity({
    asset: { address: "0x1111111111111111111111111111111111111111", issuer: "bstock", symbol: "XYZ2b", underlyingTicker: "XYZ2", decimals: 18, tokenToShareRatio: 1 },
    onChain: { tokenPriceUsd: 101, updatedAt: NOW - 10_000 },
    reference: { kind: "CROSS_ISSUER", perSharePriceUsd: 100, asOf: NOW - 10_000, source: "ondo:XYZ2on" },
    market: { available: true, openState: true, marketStatus: "regular", reasonCode: "TRADING", reasonMsg: null, nextOpenTime: null, nextCloseTime: null, isHardBlocked: false },
    liquidity: { totalUsd: 500_000, poolCount: 2 },
    notional: 250,
    now: NOW,
    ...over,
  });
}

/** Fake OpenAI Responses API. */
const responses = (...texts: string[]) => {
  const queue = [...texts];
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ model: "test-model", output: [{ type: "message", content: [{ type: "output_text", text: queue.shift() ?? "" }] }] }), { status: 200 }),
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
};

describe("attestation", () => {
  const SECRET = "server-secret-for-tests";
  it("verifies after a JSON round-trip (what the browser sends back)", () => {
    const o = opp();
    const sig = attest(JSON.stringify(o), SECRET);
    const roundTripped = JSON.stringify(JSON.parse(JSON.stringify(o)));
    expect(verifyAttestation(roundTripped, sig, SECRET)).toBe(true);
  });

  it("rejects any edit, a different secret, or junk", () => {
    const o = opp();
    const json = JSON.stringify(o);
    const sig = attest(json, SECRET);
    const tampered = JSON.stringify({ ...o, netOpportunityPercent: 5 });
    expect(verifyAttestation(tampered, sig, SECRET)).toBe(false);
    expect(verifyAttestation(json, sig, "other-secret")).toBe(false);
    expect(verifyAttestation(json, "nope", SECRET)).toBe(false);
  });

  it("does not use the raw secret as the HMAC key", () => {
    // A signature made directly with the secret must not verify.
    const { createHmac } = require("node:crypto") as typeof import("node:crypto");
    const json = JSON.stringify(opp());
    const naive = createHmac("sha256", SECRET_FOR_NAIVE).update(json).digest("base64url");
    expect(verifyAttestation(json, naive, SECRET_FOR_NAIVE)).toBe(false);
  });
});
const SECRET_FOR_NAIVE = "server-secret-for-tests";

describe("assessment facts", () => {
  it("contains engine figures and reasons, but no addresses", () => {
    const f = buildAssessmentFacts(opp());
    expect(f.spreadPercent).toBe(1);
    expect(f.classification).toBe("WATCH");
    expect(f.engineReasons.length).toBeGreaterThan(0);
    expect(JSON.stringify(f)).not.toMatch(/0x[0-9a-f]{40}/i);
  });
});

describe("validateAssessment", () => {
  const facts = buildAssessmentFacts(opp());

  it("accepts text whose numbers all come from the facts (rounding allowed)", () => {
    const text = "XYZ2b trades at a 1.00% premium to XYZ2on, $101.00 versus $100.00 per share. Without a quote the net figure is unknown, so it is marked watch. Prices can move before execution.";
    expect(validateAssessment(text, facts)).toEqual({ ok: true, numbersChecked: 3 });
  });

  it("ignores digits inside symbols and hex strings", () => {
    expect(validateAssessment("XYZ2b vs XYZ2on at 0xdeadbeef: a 1% gap.", facts).ok).toBe(true);
  });

  it("rejects invented figures", () => {
    const r = validateAssessment("The spread is 1% and liquidity is $3,000,000.", facts);
    expect(r).toMatchObject({ ok: false, reason: "unverified_number", detail: "3000000" });
  });

  it("rejects an invented price close-but-not-equal to a fact", () => {
    expect(validateAssessment("It trades at $104.50.", facts).ok).toBe(false);
  });

  it.each([
    "This is a guaranteed gain of 1%.",
    "A risk-free 1% spread.",
    "You should buy now.",
    "You will profit from this.",
  ])("rejects promissory or advice language: %s", (text) => {
    expect(validateAssessment(text, facts)).toMatchObject({ ok: false, reason: "banned_language" });
  });

  it("rejects empty and overlong text", () => {
    expect(validateAssessment("  ", facts)).toMatchObject({ ok: false, reason: "empty" });
    expect(validateAssessment("a".repeat(901), facts)).toMatchObject({ ok: false, reason: "too_long" });
  });

  it("derives allowed numbers from the facts only", () => {
    expect(allowedNumbers(facts)).toContain(101);
    expect(allowedNumbers(facts)).not.toContain(3000000);
  });
});

describe("OpenAI Responses client", () => {
  it("sends model, instructions, input, max_output_tokens and store=false; reads output_text", async () => {
    const f = responses("hello");
    const res = await createResponse({ apiKey: "sk-test", model: "m", instructions: "i", input: "x", maxOutputTokens: 100, timeoutMs: 1000, fetchImpl: f });
    expect(res).toEqual({ text: "hello", model: "test-model" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ model: "m", instructions: "i", input: "x", max_output_tokens: 100, store: false });
    expect(((init as RequestInit).headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
  });

  it("maps HTTP errors without echoing the key", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })) as unknown as typeof fetch;
    const err = await createResponse({ apiKey: "sk-secret-123", model: "m", instructions: "i", input: "x", maxOutputTokens: 1, timeoutMs: 1000, fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(OpenAiError);
    expect(err.httpStatus).toBe(401);
    expect(err.message).not.toContain("sk-secret-123");
  });

  it("treats a response with no text as empty", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ output: [{ type: "reasoning" }] }), { status: 200 })) as unknown as typeof fetch;
    const err = await createResponse({ apiKey: "k", model: "m", instructions: "i", input: "x", maxOutputTokens: 1, timeoutMs: 1000, fetchImpl: f }).catch((e) => e);
    expect(err.kind).toBe("empty");
  });
});
