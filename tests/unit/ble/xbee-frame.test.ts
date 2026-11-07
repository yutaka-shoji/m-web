import { describe, expect, it } from 'vitest';
import { buildFrame, FrameParser } from '../../../src/core/ble/xbee-frame';
import { concatBytes } from '../../../src/core/util/bytes';

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

describe('xbee frame codec', () => {
  it('builds frames with length and checksum (reference example)', () => {
    // 0x2D frame-id 0 iface 0 + "{}\n"
    const f = buildFrame(Uint8Array.of(0x2d, 0x00, 0x00, 0x7b, 0x7d, 0x0a));
    expect(Array.from(f.subarray(0, 3))).toEqual([0x7e, 0x00, 0x06]);
    const sum = [0x2d, 0, 0, 0x7b, 0x7d, 0x0a].reduce((a, b) => a + b, 0);
    expect(f[f.length - 1]).toBe(0xff - (sum & 0xff));
  });

  it('round-trips frames split at arbitrary boundaries, including 0x7E inside data', () => {
    const r = rng(7);
    const frames: Uint8Array[] = [];
    for (let i = 0; i < 200; i++) {
      const len = 1 + Math.floor(r() * 250);
      const data = new Uint8Array(len);
      for (let j = 0; j < len; j++) data[j] = r() < 0.1 ? 0x7e : Math.floor(r() * 256);
      frames.push(data);
    }
    const stream = concatBytes(...frames.map(buildFrame));
    const p = new FrameParser();
    const out: Uint8Array[] = [];
    for (let i = 0; i < stream.length; ) {
      const n = 1 + Math.floor(r() * 60);
      p.push(stream.subarray(i, i + n));
      i += n;
      for (let f = p.next(); f; f = p.next()) out.push(f);
    }
    expect(out.length).toBe(frames.length);
    out.forEach((f, i) => expect(f).toEqual(frames[i]));
    expect(p.badChecksums).toBe(0);
    expect(p.discardedBytes).toBe(0);
  });

  it('skips garbage and recovers after a corrupted frame without losing the next one', () => {
    const a = buildFrame(Uint8Array.of(0xad, 0x00, 1, 2, 3));
    const b = buildFrame(Uint8Array.of(0xad, 0x00, 4, 5, 6));
    const bad = a.slice();
    bad[4]! ^= 0xff; // corrupt data → checksum mismatch
    const p = new FrameParser();
    p.push(concatBytes(Uint8Array.of(1, 2, 3), bad, b));
    const got: Uint8Array[] = [];
    for (let f = p.next(); f; f = p.next()) got.push(f);
    expect(got).toEqual([Uint8Array.of(0xad, 0x00, 4, 5, 6)]);
    expect(p.badChecksums).toBeGreaterThanOrEqual(1);
  });

  it('hands back buffered bytes when the stream switches to ciphertext', () => {
    const p = new FrameParser();
    const f = buildFrame(Uint8Array.of(0xac, 0x04, 9));
    p.push(concatBytes(f, Uint8Array.of(0x11, 0x22, 0x7e)));
    expect(p.next()).toEqual(Uint8Array.of(0xac, 0x04, 9));
    expect(p.takeRemaining()).toEqual(Uint8Array.of(0x11, 0x22, 0x7e));
    expect(p.buffered).toBe(0);
  });
});
