import { afterEach, describe, expect, it } from 'vitest';
import { csvText, localDateTime } from '../../../src/core/data/csv';

describe('csvText', () => {
  it('quotes separators and quotes (RFC 4180)', () => {
    expect(csvText('Room A')).toBe('Room A');
    expect(csvText('会議室A')).toBe('会議室A');
    expect(csvText('A,B')).toBe('"A,B"');
    expect(csvText('say "hi"')).toBe('"say ""hi"""');
  });

  it('keeps names that a spreadsheet would run as formulas as plain text', () => {
    expect(csvText('=1+1')).toBe("'=1+1");
    expect(csvText('+81')).toBe("'+81");
    expect(csvText('-3F')).toBe("'-3F");
    expect(csvText('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvText('\t=1')).toBe("'\t=1");
    expect(csvText('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
    expect(csvText('A=1')).toBe('A=1');
  });
});

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
