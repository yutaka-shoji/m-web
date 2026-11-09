import { describe, expect, it } from 'vitest';
import { buildChartData } from '../../../src/core/data/decimate';
import { DeviceSeries } from '../../../src/core/data/series';

function series(samples: Array<[number, number | undefined]>): DeviceSeries {
  const s = new DeviceSeries(1000);
  for (const [ts, t] of samples) s.append(ts, t === undefined ? { h: 50 } : { t });
  return s;
}

describe('chart data', () => {
  it('raw mode: union x, undefined where a device has no sample, null at its own gaps', () => {
    const a = series([
      [0, 20],
      [5, 21],
      [10, 22],
      [100, 23], // gap of 90 s ≫ 3 × 5 s
    ]);
    const b = series([
      [2, 30],
      [7, 31],
    ]);
    const d = buildChartData([a, b], 't', 0, 200, 1000);
    expect(d.mode).toBe('raw');
    expect(d.x).toEqual([0, 2, 5, 7, 10, 10.001, 100]);
    expect(d.ys[0]).toEqual([20, undefined, 21, undefined, 22, null, 23]);
    expect(d.ys[1]).toEqual([undefined, 30, undefined, 31, undefined, undefined, undefined]);
  });

  it('skips samples where the channel is absent', () => {
    const a = series([
      [0, 20],
      [1, undefined],
      [2, 21],
    ]);
    const d = buildChartData([a], 't', 0, 10, 1000);
    expect(d.x).toEqual([0, 2]);
  });

  it('grid mode keeps min and max of each bucket in time order', () => {
    const samples: Array<[number, number]> = [];
    for (let i = 0; i < 1000; i++) samples.push([i, i % 10 === 3 ? 50 : i % 10 === 7 ? -50 : 0]);
    const d = buildChartData([series(samples)], 't', 0, 1000, 200);
    expect(d.mode).toBe('grid');
    expect(d.x.length).toBe(200);
    const y = d.ys[0]!;
    // each 10-s bucket contains +50 at :3 and −50 at :7 → [50, −50]
    expect(y.slice(0, 4)).toEqual([50, -50, 50, -50]);
    expect(Math.max(...(y.filter((v) => typeof v === 'number') as number[]))).toBe(50);
  });

  it('grid mode breaks the line only at real gaps', () => {
    // 1 Hz for 3 h, flat except a step, with a 10-minute pause: 20-s buckets on a 1-s step.
    const s = new DeviceSeries(20_000);
    for (let i = 0; i < 10_800; i++) {
      if (i >= 5000 && i < 5600) continue;
      s.append(i, { t: i < 2000 ? 21 : 22 });
    }
    const d = buildChartData([s], 't', 0, 10_800, 1080);
    expect(d.mode).toBe('grid');
    const breaks = d.x.filter((_x, k) => d.ys[0]![k] === null);
    expect(breaks).toHaveLength(1);
    expect(breaks[0]).toBeGreaterThan(4990);
    expect(breaks[0]).toBeLessThan(5600);
  });

  it('bounds the output size for long windows', () => {
    const samples: Array<[number, number]> = [];
    for (let i = 0; i < 86_400; i++) samples.push([i, Math.sin(i / 600)]);
    const s = new DeviceSeries(100_000);
    for (const [ts, t] of samples) s.append(ts, { t });
    const t0 = performance.now();
    const d = buildChartData([s, s, s], 't', 0, 86_400, 1200);
    expect(d.x.length).toBe(1200);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
