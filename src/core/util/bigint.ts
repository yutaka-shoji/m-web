import { fromHex, toHex } from './bytes';

export function bytesToBigInt(b: Uint8Array): bigint {
  return b.length === 0 ? 0n : BigInt('0x' + toHex(b));
}

/**
 * Big-endian bytes of a non-negative integer. Without `length` the encoding is minimal
 * (0 → one zero byte), matching Python's `_b()` helper in the reference SRP client.
 */
export function bigIntToBytes(x: bigint, length?: number): Uint8Array {
  if (x < 0n) throw new RangeError('negative bigint');
  let hex = x.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const minimal = fromHex(hex);
  if (length === undefined) return minimal;
  if (minimal.length > length) throw new RangeError(`value needs ${minimal.length} bytes > ${length}`);
  const out = new Uint8Array(length);
  out.set(minimal, length - minimal.length);
  return out;
}

export function byteLength(x: bigint): number {
  if (x === 0n) return 1;
  return Math.ceil(x.toString(16).length / 2);
}

/** (base ** exp) mod m by square-and-multiply. */
export function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  if (m === 1n) return 0n;
  let result = 1n;
  let b = ((base % m) + m) % m;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    e >>= 1n;
    b = (b * b) % m;
  }
  return result;
}
