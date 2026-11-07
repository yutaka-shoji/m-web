import { ByteQueue } from '../util/bytes';

/** XBee API frames over BLE are never escaped (AP=1): `7E lenHi lenLo data… checksum`. */
export const FRAME_DELIMITER = 0x7e;
/** Anything longer is treated as a false start delimiter (BLE frames are < 300 bytes). */
const MAX_FRAME_DATA = 512;

export function buildFrame(data: Uint8Array): Uint8Array {
  if (data.length === 0 || data.length > 0xffff) throw new RangeError('bad frame length');
  const out = new Uint8Array(data.length + 4);
  out[0] = FRAME_DELIMITER;
  out[1] = data.length >> 8;
  out[2] = data.length & 0xff;
  out.set(data, 3);
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i]!;
  out[3 + data.length] = 0xff - (sum & 0xff);
  return out;
}

/**
 * Incremental frame parser. Frames are cut by their length field (0x7E may occur inside
 * data). On a checksum mismatch only the delimiter is dropped and scanning resumes, so a
 * false delimiter cannot swallow a following valid frame.
 */
export class FrameParser {
  private readonly q = new ByteQueue(4096);
  badChecksums = 0;
  discardedBytes = 0;

  push(data: Uint8Array): void {
    this.q.push(data);
  }

  /** Next complete frame's data (type byte first), or null if more bytes are needed. */
  next(): Uint8Array | null {
    for (;;) {
      const start = this.q.indexOf(FRAME_DELIMITER);
      if (start < 0) {
        this.discardedBytes += this.q.length;
        this.q.clear();
        return null;
      }
      if (start > 0) {
        this.discardedBytes += start;
        this.q.drop(start);
      }
      if (this.q.length < 3) return null;
      const len = (this.q.at(1) << 8) | this.q.at(2);
      if (len === 0 || len > MAX_FRAME_DATA) {
        this.discardedBytes += 1;
        this.q.drop(1);
        continue;
      }
      if (this.q.length < len + 4) return null;
      const body = this.q.peek(3, len);
      let sum = this.q.at(3 + len);
      for (let i = 0; i < len; i++) sum += body[i]!;
      if ((sum & 0xff) === 0xff) {
        const frame = body.slice();
        this.q.drop(len + 4);
        return frame;
      }
      this.badChecksums += 1;
      this.discardedBytes += 1;
      this.q.drop(1);
    }
  }

  /** Remove and return every buffered byte (used when the stream switches to ciphertext). */
  takeRemaining(): Uint8Array {
    return this.q.take(this.q.length);
  }

  get buffered(): number {
    return this.q.length;
  }

  reset(): void {
    this.q.clear();
  }
}
