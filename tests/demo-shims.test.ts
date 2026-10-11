import { createHash as nodeHash, createHmac as nodeHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHash, createHmac, timingSafeEqual } from "../src/demo/shims/crypto";
import { Buffer as ShimBuffer } from "../src/demo/shims/buffer";

/* The demo's browser crypto must match Node's exactly, or signatures/hashes would differ. */
const inputs = ["", "abc", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000), "ünïcødé ✓ 🧭", JSON.stringify({ a: [1, 2, { b: "c" }] })];

describe("demo crypto shim", () => {
  it("SHA-256 matches node:crypto (incl. block boundaries and unicode)", () => {
    for (const s of inputs) {
      for (const enc of ["hex", "base64", "base64url"] as const) expect(createHash("sha256").update(s).digest(enc)).toBe(nodeHash("sha256").update(s).digest(enc));
    }
  });
  it("HMAC-SHA256 matches node:crypto for short, long and Buffer keys", () => {
    const keys = ["k", "test-secret", "z".repeat(100)];
    for (const k of keys) for (const s of inputs) expect(createHmac("sha256", k).update(s).digest("base64")).toBe(nodeHmac("sha256", k).update(s).digest("base64"));
    const derived = createHmac("sha256", "secret").update("ctx").digest();
    expect(createHmac("sha256", derived).update("msg").digest("base64url")).toBe(nodeHmac("sha256", nodeHmac("sha256", "secret").update("ctx").digest()).update("msg").digest("base64url"));
  });
  it("multi-part update equals single update", () => {
    expect(createHash("sha256").update("ab").update("c").digest("hex")).toBe(nodeHash("sha256").update("abc").digest("hex"));
  });
  it("Buffer shim round-trips base64url and utf8", () => {
    const s = '{"x":"ünï ✓"}';
    const b64 = ShimBuffer.from(s).toString("base64url");
    expect(b64).toBe(Buffer.from(s).toString("base64url"));
    expect(ShimBuffer.from(b64, "base64url").toString("utf8")).toBe(s);
  });
  it("timingSafeEqual compares bytes and rejects length mismatch", () => {
    expect(timingSafeEqual(ShimBuffer.from("abc"), ShimBuffer.from("abc"))).toBe(true);
    expect(timingSafeEqual(ShimBuffer.from("abc"), ShimBuffer.from("abd"))).toBe(false);
    expect(() => timingSafeEqual(ShimBuffer.from("a"), ShimBuffer.from("ab"))).toThrow();
  });
  it("refuses algorithms it doesn't implement", () => {
    expect(() => createHash("md5")).toThrow(/sha256 only/);
  });
});
