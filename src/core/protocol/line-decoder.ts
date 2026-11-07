/**
 * Splits the relay byte stream into lines (terminated by \n or \r, empty lines skipped)
 * and supports a synchronous switch to binary mode for `dump`: when the dump header line
 * is handed to `onLine`, the handler calls `startBinary(n, sink)` and the remaining bytes
 * of the same chunk — and the following chunks — go to `sink` until n bytes were consumed.
 *
 * Lines are decoded as UTF-8 only once complete, so multi-byte characters split across
 * relay frames are safe.
 */
export class LineDecoder {
  private buf = new Uint8Array(1024);
  private len = 0;
  private binRemaining = 0;
  private binSink: ((bytes: Uint8Array) => void) | null = null;
  private readonly utf8 = new TextDecoder();
  private readonly onLine: (line: string) => void;
  private readonly maxLine: number;
  /** Lines longer than `maxLine` that were dropped. */
  overflows = 0;

  constructor(onLine: (line: string) => void, maxLine = 2048) {
    this.onLine = onLine;
    this.maxLine = maxLine;
  }

  get inBinaryMode(): boolean {
    return this.binRemaining > 0;
  }

  push(chunk: Uint8Array): void {
    let i = 0;
    while (i < chunk.length) {
      if (this.binRemaining > 0) {
        const n = Math.min(this.binRemaining, chunk.length - i);
        const sink = this.binSink!;
        this.binRemaining -= n;
        if (this.binRemaining === 0) this.binSink = null;
        sink(chunk.subarray(i, i + n));
        i += n;
        continue;
      }
      let j = i;
      while (j < chunk.length && chunk[j] !== 0x0a && chunk[j] !== 0x0d) j++;
      this.append(chunk.subarray(i, j));
      if (j < chunk.length) {
        i = j + 1;
        this.flushLine(); // may call startBinary() synchronously
      } else {
        i = j;
      }
    }
  }

  /** Route the next `n` bytes to `sink` (called from within onLine). */
  startBinary(n: number, sink: (bytes: Uint8Array) => void): void {
    if (n <= 0) return;
    this.binRemaining = n;
    this.binSink = sink;
  }

  /** Leave binary mode early; returns how many bytes were still expected. */
  cancelBinary(): number {
    const r = this.binRemaining;
    this.binRemaining = 0;
    this.binSink = null;
    return r;
  }

  /** Drop any partial line and leave binary mode. */
  reset(): void {
    this.len = 0;
    this.cancelBinary();
  }

  private append(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    if (this.len + bytes.length > this.maxLine) {
      this.overflows += 1;
      this.len = 0;
      return;
    }
    if (this.len + bytes.length > this.buf.length) {
      const next = new Uint8Array(Math.min(this.maxLine, Math.max(this.buf.length * 2, this.len + bytes.length)));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  private flushLine(): void {
    if (this.len === 0) return;
    const line = this.utf8.decode(this.buf.subarray(0, this.len));
    this.len = 0;
    this.onLine(line);
  }
}
