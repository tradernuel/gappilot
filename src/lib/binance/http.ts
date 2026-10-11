import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { BinanceApiError } from "./errors";
import { buildRequestTarget, signRequest } from "./signer";
import type { EndpointSpec } from "./endpoints";
import type { BinanceEnvelope, BinanceResult, RateLimitInfo } from "./types/common";
import { silentLogger, type Logger } from "../logging/logger";

export interface HttpClientConfig {
  apiKey: string;
  apiSecret: string;
  /** e.g. https://web3.binance.com/build — the path prefix is part of the signature. */
  baseUrl: string;
  recvWindowMs: number;
  timeoutMs: number;
  /** Max in-flight requests. Default 2. */
  maxConcurrency?: number;
  /** Extra attempts for retryable GET failures. Default 2. POSTs are never retried. */
  maxRetries?: number;
  /** Structured logger. Default: silent. */
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => Date;
  /** Injectable for tests (defaults to setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

export type QueryParams = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  /** Values substituted into `{name}` placeholders in the path. */
  pathParams?: Record<string, string>;
  /** Runtime shape check for `data`. Mismatch → BinanceApiError(kind "parse"). */
  schema?: z.ZodType;
}

const BODY_SNIPPET_MAX = 500;

/** Simple FIFO semaphore so parallel scans don't trip the gateway rate limit. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
  const int = (name: string): number | undefined => {
    const raw = headers.get(name);
    if (raw === null) return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : undefined;
  };
  const info: RateLimitInfo = {};
  const limit = int("x-oc-ratelimit-limit");
  const remaining = int("x-oc-ratelimit-remaining");
  const usedWeight = int("x-oc-used-weight");
  const retryAfter = int("retry-after");
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (usedWeight !== undefined) info.usedWeight = usedWeight;
  if (retryAfter !== undefined) info.retryAfter = retryAfter;
  return info;
}

function substitutePath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/\{(\w+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      throw new BinanceApiError({
        kind: "validation",
        endpoint: path,
        message: `Missing path parameter "${name}" for ${path}`,
        issues: [{ path: name, message: "required" }],
      });
    }
    return encodeURIComponent(value);
  });
}

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" || (err.name === "AbortError" && /timeout/i.test(String(err.message))))
  );
}

export class BinanceHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly semaphore: Semaphore;
  private readonly maxRetries: number;
  private readonly log: Logger;

  constructor(private readonly config: HttpClientConfig) {
    if (!config.apiKey || !config.apiSecret) {
      throw new Error("BinanceHttpClient requires apiKey and apiSecret");
    }
    if (!(config.timeoutMs > 0)) throw new Error("BinanceHttpClient requires a positive timeoutMs");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? (() => new Date());
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.semaphore = new Semaphore(Math.max(1, config.maxConcurrency ?? 2));
    this.maxRetries = Math.max(0, config.maxRetries ?? 2);
    this.log = (config.logger ?? silentLogger).child({ component: "binance-http" });
  }

  async request<T>(spec: EndpointSpec, options: RequestOptions = {}): Promise<BinanceResult<T>> {
    const path = substitutePath(spec.path, options.pathParams);
    const attempts = spec.method === "GET" ? this.maxRetries + 1 : 1;
    const endpoint = `${spec.method} ${spec.path}`;

    for (let attempt = 1; ; attempt++) {
      const started = Date.now();
      try {
        const result = await this.semaphore.run(() => this.once<T>(spec, path, options));
        this.log.info("binance.request.ok", {
          endpoint,
          attempt,
          latencyMs: Date.now() - started,
          rateLimit: result.rateLimit,
        });
        if (result.serverTime != null) {
          const skewMs = Date.now() - result.serverTime;
          if (Math.abs(skewMs) > this.config.recvWindowMs / 2) {
            this.log.warn("binance.clock_skew", { endpoint, skewMs, recvWindowMs: this.config.recvWindowMs });
          }
        }
        return result;
      } catch (err) {
        const apiErr = err instanceof BinanceApiError ? err : undefined;
        const willRetry = apiErr?.isRetryable === true && attempt < attempts;
        const fields = {
          endpoint,
          attempt,
          latencyMs: Date.now() - started,
          kind: apiErr?.kind ?? "unknown",
          httpStatus: apiErr?.httpStatus,
          code: apiErr?.code,
          message: err instanceof Error ? err.message : String(err),
          issues: apiErr?.issues,
          rateLimit: apiErr?.rateLimit,
          willRetry,
        };
        if (willRetry) this.log.warn("binance.request.retry", fields);
        else this.log.error("binance.request.failed", fields);
        if (apiErr?.bodySnippet) this.log.debug("binance.request.failed.body", { endpoint, body: apiErr.bodySnippet });

        if (!willRetry) throw err;
        const retryAfterMs = (apiErr?.rateLimit?.retryAfter ?? 0) * 1000;
        await this.sleep(Math.max(retryAfterMs, 250 * 2 ** (attempt - 1)));
      }
    }
  }

  private async once<T>(spec: EndpointSpec, path: string, options: RequestOptions): Promise<BinanceResult<T>> {
    const { url, requestPath } = buildRequestTarget(this.config.baseUrl, path, options.query ?? {});
    const bodyString = options.body === undefined ? "" : JSON.stringify(options.body);
    const timestamp = this.now().toISOString();
    const signature = signRequest(this.config.apiSecret, timestamp, spec.method, requestPath, bodyString);

    // Headers live only in this scope. They are never logged or attached to errors.
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-OC-APIKEY": this.config.apiKey,
      "X-OC-TIMESTAMP": timestamp,
      "X-OC-SIGN": signature,
      "X-OC-RECV-WINDOW": String(this.config.recvWindowMs),
      // Spec: nonce falls back to X-OC-SIGN when omitted; an explicit UUID makes retries distinct.
      "X-OC-NONCE": randomUUID(),
    };

    const endpoint = `${spec.method} ${spec.path}`;
    let response: Response;
    let text: string;
    try {
      // The timeout covers connecting AND reading the body.
      const signal = AbortSignal.timeout(this.config.timeoutMs);
      response = await this.fetchImpl(url, {
        method: spec.method,
        headers,
        body: bodyString === "" ? undefined : bodyString,
        signal,
        cache: "no-store",
      });
      text = await response.text();
    } catch (cause) {
      if (isTimeoutError(cause)) {
        throw new BinanceApiError({
          kind: "timeout",
          endpoint,
          message: `${endpoint} timed out after ${this.config.timeoutMs} ms`,
          cause,
        });
      }
      throw new BinanceApiError({
        kind: "network",
        endpoint,
        message: `Network error calling ${endpoint}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      });
    }

    const rateLimit = parseRateLimitHeaders(response.headers);
    const snippet = text.slice(0, BODY_SNIPPET_MAX);

    let envelope: BinanceEnvelope<T> | undefined;
    try {
      envelope = text ? (JSON.parse(text) as BinanceEnvelope<T>) : undefined;
    } catch {
      envelope = undefined;
    }

    if (!response.ok) {
      throw new BinanceApiError({
        kind: "http",
        endpoint,
        httpStatus: response.status,
        code: typeof envelope?.code === "number" ? envelope.code : undefined,
        rateLimit,
        bodySnippet: snippet,
        message: `${endpoint} failed with HTTP ${response.status}${envelope?.msg ? `: ${envelope.msg}` : ""}`,
      });
    }

    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) || !("code" in envelope)) {
      throw new BinanceApiError({
        kind: "parse",
        endpoint,
        httpStatus: response.status,
        rateLimit,
        bodySnippet: snippet,
        message: `${endpoint} returned a body that is not a Binance envelope`,
      });
    }

    // Spec types `code` as a number (0 = success). Tolerate "0" in case the gateway stringifies it.
    if (Number(envelope.code) !== 0) {
      throw new BinanceApiError({
        kind: "business",
        endpoint,
        httpStatus: response.status,
        code: Number.isFinite(Number(envelope.code)) ? Number(envelope.code) : undefined,
        rateLimit,
        bodySnippet: snippet,
        message: `${endpoint} returned business code ${envelope.code}${envelope.msg ? `: ${envelope.msg}` : ""}`,
      });
    }

    if (options.schema) {
      const checked = options.schema.safeParse(envelope.data);
      if (!checked.success) {
        const issues = checked.error.issues.slice(0, 10).map((i) => ({
          path: `data${i.path.length ? "." : ""}${i.path.join(".")}`,
          message: i.message,
        }));
        throw new BinanceApiError({
          kind: "parse",
          endpoint,
          httpStatus: response.status,
          rateLimit,
          bodySnippet: snippet,
          issues,
          message: `${endpoint} returned malformed data: ${issues.map((i) => `${i.path} ${i.message}`).join("; ")}`,
        });
      }
    }

    return {
      // `data` may legitimately be null (e.g. /aggregator/history for an unknown tx).
      data: envelope.data as T,
      rateLimit,
      serverTime: typeof envelope.timestamp === "number" ? envelope.timestamp : undefined,
    };
  }
}
