/**
 * Read-only decoding of Binance-built ERC-20 approve calldata, so the user
 * (and our checks) can see exactly what an approval grants. Never encodes.
 */
export const APPROVE_SELECTOR = "0x095ea7b3";
export const MAX_UINT256 = (1n << 256n) - 1n;

export interface DecodedApprove {
  spender: string;
  amount: bigint;
}

export function decodeApprove(data: string): DecodedApprove | null {
  const d = data.toLowerCase();
  if (!/^0x[0-9a-f]*$/.test(d) || !d.startsWith(APPROVE_SELECTOR) || d.length !== 10 + 64 * 2) return null;
  const spenderWord = d.slice(10, 74);
  const amountWord = d.slice(74, 138);
  if (!/^0{24}/.test(spenderWord)) return null; // address must be left-padded
  return { spender: `0x${spenderWord.slice(24)}`, amount: BigInt(`0x${amountWord}`) };
}

export const sameAddress = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();
