import { describe, expect, it } from 'vitest';
import vectors from '../../fixtures/record-vectors.json';
import { decodeRecord, decodeRecords, RECORD_SIZE } from '../../../src/core/protocol/record';
import { concatBytes, fromHex } from '../../../src/core/util/bytes';

describe('flash record decoding', () => {
  it.each(vectors.map((v, i) => [i, v] as const))('matches struct.pack golden vector %i', (_i, v) => {
    const bytes = fromHex(v.hex);
    expect(bytes.length).toBe(RECORD_SIZE);
    const r = decodeRecord(new DataView(bytes.buffer), 0);
    for (const [k, want] of Object.entries(v.expected)) {
      const got = r[k as keyof typeof r];
      if (want === null) expect(got, k).toBeNull();
      else expect(got, k).toBeCloseTo(want as number, 9);
    }
  });

  it('decodes a concatenated stream at a non-zero byte offset', () => {
    const all = concatBytes(Uint8Array.of(9, 9, 9), ...vectors.map((v) => fromHex(v.hex)));
    const records = decodeRecords(all.subarray(3));
    expect(records.length).toBe(vectors.length);
    expect(records[1]!.t).toBeCloseTo(-12.34, 9);
  });
});
