import { describe, expect, it } from "vitest";
import { createLogger, createRedactor, REDACTED } from "../src/lib/logging/logger";

const capture = (secrets: string[] = []) => {
  const lines: string[] = [];
  const log = createLogger({ level: "debug", sink: (_l, line) => lines.push(line), secrets, now: () => new Date(0) });
  return { log, lines, last: () => JSON.parse(lines.at(-1)!) };
};

describe("logger redaction", () => {
  it("redacts secret-looking keys at any depth", () => {
    const { log, last } = capture();
    log.info("x", {
      apiKey: "k",
      nested: { "X-OC-SIGN": "s", privateKey: "p", seed_phrase: "w", userSignature: "sig", ok: "visible" },
    });
    expect(last()).toMatchObject({
      apiKey: REDACTED,
      nested: { "X-OC-SIGN": REDACTED, privateKey: REDACTED, seed_phrase: REDACTED, userSignature: REDACTED, ok: "visible" },
    });
  });

  it("scrubs registered secret values inside free text", () => {
    const { log, lines } = capture(["super-secret-value-123"]);
    log.error("failed", { message: "upstream said super-secret-value-123 was wrong" });
    expect(lines[0]).not.toContain("super-secret-value-123");
  });

  it("scrubs 65-byte signatures and seed-phrase-shaped text, but keeps tx hashes", () => {
    const { redact } = createRedactor([]);
    const sig = `0x${"ab".repeat(65)}`;
    const txHash = `0x${"cd".repeat(32)}`;
    const phrase = "abandon ability able about above absent absorb abstract absurd abuse access accident";
    const out = JSON.stringify(redact({ a: `sig=${sig}`, b: txHash, c: phrase }));
    expect(out).not.toContain(sig);
    expect(out).toContain(txHash);
    expect(out).not.toContain(phrase);
  });

  it("respects the minimum level and emits one JSON object per line", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", sink: (_l, line) => lines.push(line) });
    log.info("hidden");
    log.warn("shown", { n: 1 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: "warn", msg: "shown", n: 1 });
  });

  it("child loggers carry bindings and still redact", () => {
    const { log, last } = capture();
    log.child({ op: "rwa/price", secret: "nope" }).info("x");
    expect(last()).toMatchObject({ op: "rwa/price", secret: REDACTED });
  });
});
