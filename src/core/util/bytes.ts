/** Small byte helpers shared by the BLE link and the protocol layer. */

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0) throw new Error('odd-length hex string');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) throw new Error(`invalid hex at ${i * 2}`);
    out[i] = v;
  }
  return out;
}

const utf8Encoder = new TextEncoder();
export function utf8(s: string): Uint8Array {
  return utf8Encoder.encode(s);
}

/**
 * Growable byte buffer with an amortised O(1) append and cheap consume-from-front.
 * Used for the frame parser and the line decoder so we never concat per chunk.
 */
export class ByteQueue {
  private buf: Uint8Array;
  private start = 0;
  private end = 0;

  constructor(initialCapacity = 4096) {
    this.buf = new Uint8Array(initialCapacity);
  }

  get length(): number {
    return this.end - this.start;
  }

  push(data: Uint8Array): void {
    if (data.length === 0) return;
    if (this.end + data.length > this.buf.length) this.compact(data.length);
    this.buf.set(data, this.end);
    this.end += data.length;
  }

  /** Byte at logical index `i` (0 = oldest). */
  at(i: number): number {
    return this.buf[this.start + i]!;
  }

  /** Index of the first occurrence of `value` at or after `from`, or -1. */
  indexOf(value: number, from = 0): number {
    const i = this.buf.subarray(this.start + from, this.end).indexOf(value);
    return i < 0 ? -1 : i + from;
  }

  /** View (not a copy) of `n` bytes starting at logical `from`. Invalidated by the next push. */
  peek(from: number, n: number): Uint8Array {
    return this.buf.subarray(this.start + from, this.start + from + n);
  }

  /** Copy of the first `n` bytes, removing them. */
  take(n: number): Uint8Array {
    const out = this.buf.slice(this.start, this.start + n);
    this.drop(n);
    return out;
  }

  drop(n: number): void {
    this.start += Math.min(n, this.length);
    if (this.start === this.end) this.start = this.end = 0;
  }

  clear(): void {
    this.start = this.end = 0;
  }

  private compact(extra: number): void {
    const len = this.length;
    const need = len + extra;
    if (need <= this.buf.length && this.start > 0) {
      this.buf.copyWithin(0, this.start, this.end);
    } else {
      let cap = this.buf.length;
      while (cap < need) cap *= 2;
      const next = new Uint8Array(cap);
      next.set(this.buf.subarray(this.start, this.end));
      this.buf = next;
    }
    this.start = 0;
    this.end = len;
  }
}
