import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Attestation: the server signs each Opportunity it produced (HMAC-SHA256 over
 * its exact JSON). The browser sends the JSON + signature back to request an
 * AI assessment, so the explanation layer only ever sees engine output that
 * GapPilot itself computed — never numbers edited in the browser.
 *
 * The HMAC key is DERIVED from a server secret (not the secret itself).
 */
const CONTEXT = "gappilot:opportunity-attestation:v1";

function deriveKey(serverSecret: string): Buffer {
  if (!serverSecret) throw new Error("attestation requires a server secret");
  return createHmac("sha256", serverSecret).update(CONTEXT).digest();
}

export function attest(opportunityJson: string, serverSecret: string): string {
  return createHmac("sha256", deriveKey(serverSecret)).update(opportunityJson, "utf8").digest("base64url");
}

export function verifyAttestation(opportunityJson: string, signature: string, serverSecret: string): boolean {
  if (typeof opportunityJson !== "string" || typeof signature !== "string") return false;
  const expected = Buffer.from(attest(opportunityJson, serverSecret));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
