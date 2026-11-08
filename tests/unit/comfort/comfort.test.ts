import { describe, expect, it } from 'vitest';
import vectors from '../../fixtures/comfort-vectors.json';
import { meanRadiantTemperature } from '../../../src/core/comfort/mrt';
import { iso7730RangeIssues, pmvPpd, relativeAirSpeed } from '../../../src/core/comfort/pmv';

describe('PMV / PPD (ISO 7730)', () => {
  it.each(vectors.pmv.map((c) => [`${c.ta}/${c.tr} °C, ${c.vr} m/s, ${c.rh} %, ${c.met} met, ${c.clo} clo`, c] as const))(
    'matches pythermalcomfort: %s',
    (_label, c) => {
      const r = pmvPpd({ ta: c.ta, tr: c.tr, vr: c.vr, rh: c.rh, met: c.met, clo: c.clo });
      expect(Math.abs(r.pmv - c.pmv)).toBeLessThan(0.005);
      expect(Math.abs(r.ppd - c.ppd)).toBeLessThan(0.1);
    },
  );

  // ISO 7730:2005 Table D.1 rows (published, rounded to 2 decimals / integer %). The
  // pythermalcomfort vectors above are the primary reference; these are a second anchor.
  const table: Array<[number, number, number, number, number, number, number, number]> = [
    [22.0, 22.0, 0.1, 60, 1.2, 0.5, -0.75, 17],
    [27.0, 27.0, 0.1, 60, 1.2, 0.5, 0.77, 17],
    [27.0, 27.0, 0.3, 60, 1.2, 0.5, 0.44, 9],
    [23.5, 25.5, 0.1, 60, 1.2, 0.5, -0.01, 5],
    [23.5, 25.5, 0.3, 60, 1.2, 0.5, -0.55, 11],
    [19.0, 19.0, 0.1, 40, 1.2, 1.0, -0.6, 13],
    [23.5, 23.5, 0.3, 40, 1.2, 1.0, 0.12, 5],
    [23.0, 21.0, 0.1, 40, 1.2, 1.0, 0.05, 5],
    [23.0, 21.0, 0.3, 40, 1.2, 1.0, -0.16, 6],
    [22.0, 22.0, 0.1, 60, 1.6, 0.5, 0.05, 5],
    [27.0, 27.0, 0.1, 60, 1.6, 0.5, 1.17, 34],
    [27.0, 27.0, 0.3, 60, 1.6, 0.5, 0.95, 24],
  ];
  it.each(table)('ISO 7730 Table D.1: %s/%s °C %s m/s %s %% %s met %s clo', (ta, tr, vr, rh, met, clo, pmv, ppd) => {
    const r = pmvPpd({ ta, tr, vr, rh, met, clo });
    expect(Math.abs(r.pmv - pmv)).toBeLessThanOrEqual(0.0101);
    expect(Math.abs(r.ppd - ppd)).toBeLessThanOrEqual(0.51);
  });

  it('flags inputs outside the ISO 7730 range without hiding the value', () => {
    const input = { ta: 32, tr: 33, vr: 0.1, rh: 50, met: 1.1, clo: 0.5 };
    const r = pmvPpd(input);
    expect(Number.isFinite(r.pmv)).toBe(true);
    expect(iso7730RangeIssues(input, r.pmv)).toContain('ta');
  });

  it('relative air speed adds 0.3·(M−1) above 1 met only', () => {
    expect(relativeAirSpeed(0.1, 1.0)).toBe(0.1);
    expect(relativeAirSpeed(0.1, 1.6)).toBeCloseTo(0.28, 10);
  });

  it('is fast enough to recompute large exports on the fly', () => {
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 100_000; i++) acc += pmvPpd({ ta: 20 + (i % 10), tr: 22, vr: 0.1, rh: 50, met: 1.1, clo: 1 }).pmv;
    const ms = performance.now() - t0;
    expect(Number.isFinite(acc)).toBe(true);
    expect(ms).toBeLessThan(1500); // ≈ µs per evaluation
  });
});

describe('MRT from the 38 mm globe (ISO 7726)', () => {
  it.each(vectors.mrt.map((c) => [`ta ${c.ta}, tg ${c.tg}, v ${c.v}`, c] as const))('matches reference: %s', (_l, c) => {
    expect(meanRadiantTemperature(c.ta, c.tg, c.v)).toBeCloseTo(c.mrt, 9);
  });

  it('equals the globe temperature when globe and air are equal', () => {
    expect(meanRadiantTemperature(24, 24, 0.2)).toBeCloseTo(24, 9);
  });
});
