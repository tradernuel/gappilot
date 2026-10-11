import type { RateLimitInfo } from "./types/common";

/**
 * Error raised for any failed Binance Web3 API call.
 *
 * Kinds:
 *  - "validation": our input failed validation; NO request was sent
 *  - "http":       non-2xx HTTP status (401 bad key, 429 rate limit, 5xx, ...)
 *  - "business":   HTTP 2xx but envelope `code !== 0`
 *  - "timeout":    request exceeded BINANCE_WEB3_TIMEOUT_MS
 *  - "network":    fetch failed (DNS, TLS, connection reset)
 *  - "parse":      body is not JSON, not an envelope, or `data` has the wrong shape
 */
export type BinanceErrorKind = "validation" | "http" | "business" | "timeout" | "network" | "parse";

export interface ValidationIssue {
  path: string;
  message: string;
}

export class BinanceApiError extends Error {
  readonly kind: BinanceErrorKind;
  readonly endpoint: string;
  readonly httpStatus?: number;
  /** Envelope business code, e.g. 40001 PARAM_ERROR, 40401 QUOTE_EXPIRED. */
  readonly code?: number;
  readonly rateLimit?: RateLimitInfo;
  /** Raw upstream body, truncated. Upstream bodies never contain our secrets. */
  readonly bodySnippet?: string;
  /** Present for kind "validation" and response-shape "parse" errors. */
  readonly issues?: ValidationIssue[];

  constructor(args: {
    kind: BinanceErrorKind;
    endpoint: string;
    message: string;
    httpStatus?: number;
    code?: number;
    rateLimit?: RateLimitInfo;
    bodySnippet?: string;
    issues?: ValidationIssue[];
    cause?: unknown;
  }) {
    super(args.message, { cause: args.cause });
    this.name = "BinanceApiError";
    this.kind = args.kind;
    this.endpoint = args.endpoint;
    this.httpStatus = args.httpStatus;
    this.code = args.code;
    this.rateLimit = args.rateLimit;
    this.bodySnippet = args.bodySnippet;
    this.issues = args.issues;
  }

  /** Only transient conditions. The HTTP layer additionally never retries POST. */
  get isRetryable(): boolean {
    if (this.kind === "network" || this.kind === "timeout") return true;
    if (this.kind === "http" && this.httpStatus !== undefined) {
      return this.httpStatus === 429 || this.httpStatus >= 500;
    }
    return false;
  }

  /** Safe, secret-free summary for logs and API responses. */
  toJSON() {
    return {
      kind: this.kind,
      endpoint: this.endpoint,
      message: this.message,
      httpStatus: this.httpStatus,
      code: this.code,
      issues: this.issues,
    };
  }
}

/**
 * Business codes named in the spec text. Not exhaustive.
 * 40101 is reported by another hackathon team, not by the spec.
 */
export const KNOWN_BUSINESS_CODES = {
  PARAM_ERROR: 40001,
  API_KEY_REQUIRED: 40101,
  QUOTE_EXPIRED: 40401,
  INVALID_FEE_PERCENT: 40466,
  INVALID_REFERRER_ADDRESS: 40467,
  CONFLICT_REFERRER_PARAMS: 40468,
  REFERRER_NOT_ACTIVATED: 40469,
} as const;
