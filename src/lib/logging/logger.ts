/**
 * Structured JSON-lines logger with mandatory redaction.
 *
 * Redaction happens in three layers, applied to every field before output:
 *  1. Key names: any field whose key looks secret (api key, secret, signature,
 *     private key, mnemonic/seed, authorization, typed data to sign) is replaced.
 *  2. Registered secret values: the exact API key / secret strings are scrubbed
 *     wherever they appear, even inside an error message.
 *  3. Patterns: 65-byte hex signatures and 12–24-word lowercase phrases
 *     (seed-phrase shape) are scrubbed from any string.
 *
 * Callers should still never pass secrets in. Redaction is the safety net.
 *
 * Vercel captures stdout/stderr as logs, so JSON lines are searchable there.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

export type LogSink = (level: LogLevel, line: string) => void;

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const REDACTED = "[REDACTED]";

/** Normalised (lowercased, no - or _) key names that are always redacted. */
const SECRET_KEYS = new Set([
  "apikey",
  "apisecret",
  "secret",
  "secretkey",
  "xocapikey",
  "xocsign",
  "sign",
  "signature",
  "usersignature",
  "privatekey",
  "pk",
  "mnemonic",
  "seed",
  "seedphrase",
  "password",
  "passphrase",
  "authorization",
  "cookie",
  "typeddatatosign",
  "signedtransaction",
]);

const normaliseKey = (k: string) => k.toLowerCase().replace(/[-_]/g, "");

/** 65-byte ECDSA signature (0x + 130 hex). Tx hashes (64 hex) are intentionally NOT matched. */
const SIGNATURE_PATTERN = /0x[0-9a-fA-F]{130}\b/g;
/** 12–24 lowercase words separated by single spaces: BIP-39 phrase shape. */
const MNEMONIC_PATTERN = /\b(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b/g;

const MAX_DEPTH = 6;
const MAX_STRING = 2_000;

export function createRedactor(secretValues: Array<string | undefined>) {
  // Only scrub values long enough to be meaningful, longest first.
  const secrets = secretValues
    .filter((s): s is string => typeof s === "string" && s.length >= 8)
    .sort((a, b) => b.length - a.length);

  const scrubString = (value: string): string => {
    let out = value;
    for (const s of secrets) out = out.split(s).join(REDACTED);
    out = out.replace(SIGNATURE_PATTERN, "[REDACTED_SIGNATURE]");
    out = out.replace(MNEMONIC_PATTERN, "[REDACTED_PHRASE]");
    return out.length > MAX_STRING ? `${out.slice(0, MAX_STRING)}…` : out;
  };

  const redact = (value: unknown, depth = 0): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return scrubString(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (depth >= MAX_DEPTH) return "[TRUNCATED]";
    if (value instanceof Error) {
      return { name: value.name, message: scrubString(value.message) };
    }
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
    if (typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = SECRET_KEYS.has(normaliseKey(k)) ? REDACTED : redact(v, depth + 1);
      }
      return out;
    }
    return String(value);
  };

  return { redact, scrubString };
}

const defaultSink: LogSink = (level, line) => {
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
};

export function createLogger(options: {
  level?: LogLevel;
  sink?: LogSink;
  /** Exact secret values to scrub everywhere (API key, API secret). */
  secrets?: Array<string | undefined>;
  bindings?: LogFields;
  now?: () => Date;
} = {}): Logger {
  const minLevel = LEVEL_ORDER[options.level ?? "info"];
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());
  const { redact } = createRedactor(options.secrets ?? []);

  const make = (bindings: LogFields): Logger => {
    const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
      if (LEVEL_ORDER[level] < minLevel) return;
      const record = redact({ ts: now().toISOString(), level, msg, ...bindings, ...fields });
      sink(level, JSON.stringify(record));
    };
    return {
      debug: (m, f) => emit("debug", m, f),
      info: (m, f) => emit("info", m, f),
      warn: (m, f) => emit("warn", m, f),
      error: (m, f) => emit("error", m, f),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  };

  return make(options.bindings ?? {});
}

/** A logger that discards everything (default for library code and tests). */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
