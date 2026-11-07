import { afterEach, describe, expect, it } from 'vitest';
import { localDateTime } from '../../../src/core/data/csv';

// Node re-reads process.env.TZ for every Date operation, so zones can be switched per test.
const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

function inZone(tz: string, tsSec: number): string {
  process.env.TZ = tz;
  return localDateTime(tsSec);
}

describe('localDateTime', () => {
  it('writes local time followed by the UTC offset', () => {
    expect(inZone('Asia/Tokyo', 1_794_042_000)).toBe('2026-11-07 18:00:00+09:00');
  });

  it('uses the offset in force at that instant (daylight saving time)', () => {
    expect(inZone('America/New_York', Date.UTC(2026, 6, 1, 12) / 1000)).toBe('2026-07-01 08:00:00-04:00');
    expect(inZone('America/New_York', Date.UTC(2026, 0, 15, 12) / 1000)).toBe('2026-01-15 07:00:00-05:00');
  });

  it('handles half-hour offsets and UTC', () => {
    expect(inZone('Asia/Kolkata', Date.UTC(2026, 0, 1, 0) / 1000)).toBe('2026-01-01 05:30:00+05:30');
    expect(inZone('UTC', Date.UTC(2026, 0, 1, 0) / 1000)).toBe('2026-01-01 00:00:00+00:00');
  });
});
