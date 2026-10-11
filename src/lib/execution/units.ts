/** Exact decimal ⇄ smallest-unit conversion with BigInt (no floats). */
export function rawToDecimalString(raw: string, decimals: number): string {
  if (!/^\d+$/.test(raw)) throw new Error(`invalid raw amount: ${raw}`);
  const s = raw.padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}

/** Parses a decimal string to smallest units, truncating extra precision (conservative for minimum checks). */
export function decimalStringToRaw(value: string, decimals: number): bigint | null {
  const v = value.trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  return BigInt(w! + f.padEnd(decimals, "0").slice(0, decimals));
}
