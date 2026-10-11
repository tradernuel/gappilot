/**
 * DEMO BUILD ONLY. Minimal Buffer for the browser bundle: the subset GapPilot's
 * signing/attestation code uses (from/toString with utf8, hex, base64, base64url).
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Bytes with Node-style toString(encoding). */
export class BufferBytes extends Uint8Array {
  override toString(encoding: string = "utf8"): string {
    switch (encoding) {
      case "hex":
        return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
      case "base64":
        return b64encode(this);
      case "base64url":
        return b64encode(this).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      default:
        return dec.decode(this);
    }
  }
}

/** Node-style Buffer.from for the encodings GapPilot uses. */
export const Buffer = {
  from(input: string | ArrayLike<number> | ArrayBuffer, encoding: string = "utf8"): BufferBytes {
    if (typeof input !== "string") return new BufferBytes(input instanceof ArrayBuffer ? new Uint8Array(input) : Array.from(input as ArrayLike<number>));
    switch (encoding) {
      case "hex": {
        const out = new BufferBytes(input.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(input.substr(i * 2, 2), 16);
        return out;
      }
      case "base64":
        return new BufferBytes(b64decode(input));
      case "base64url": {
        const b64 = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
        return new BufferBytes(b64decode(b64));
      }
      default:
        return new BufferBytes(enc.encode(input));
    }
  },
};
