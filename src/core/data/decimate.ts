/**
 * Chart data for one channel across several devices, bounded in size regardless of how long
 * the window is.
 *
 * - raw mode: union of all sample times; a device has `undefined` where it has no sample
 *   (uPlot joins across it) and `null` where its own data has a real gap (uPlot breaks the line)
 * - grid mode (more points than pixels): one min and one max per pixel bucket and device,
 *   in time order, on a shared x grid — the envelope of the signal survives decimation.
 *   Computed in a single allocation-free pass over the ring buffer.
 */
import type { DeviceSeries, SeriesChannel } from './series';

export type Y = number | null | undefined;

export interface ChartData {
  x: number[];
  ys: Y[][];
  mode: 'raw' | 'grid';
}

/** A gap is a pause much longer than the device's usual step (median of a small sample). */
function gapThreshold(series: DeviceSeries, ch: SeriesChannel, t0: number, t1: number): number {
  const dts: number[] = [];
  let prev = NaN;
  series.forEachValue(ch, t0, t1, (ts) => {
    if (prev === prev) dts.push(ts - prev);
    prev = ts;
    return dts.length < 64;
  });
  if (dts.length === 0) return 600;
  dts.sort((a, b) => a - b);
  return Math.max(3 * dts[dts.length >> 1]!, 10);
}

export function buildChartData(
  seriesList: readonly DeviceSeries[],
  ch: SeriesChannel,
  t0: number,
  t1: number,
  maxPoints: number,
): ChartData {
  const most = Math.max(0, ...seriesList.map((s) => s.countInRange(t0, t1)));
  return most <= maxPoints
    ? raw(seriesList, ch, t0, t1)
    : grid(seriesList, ch, t0, t1, Math.max(1, Math.floor(maxPoints / 2)));
}

function raw(seriesList: readonly DeviceSeries[], ch: SeriesChannel, t0: number, t1: number): ChartData {
  const events: Array<[number, number, number | null]> = [];
  seriesList.forEach((s, d) => {
    const gapS = gapThreshold(s, ch, t0, t1);
    let prev = NaN;
    s.forEachValue(ch, t0, t1, (ts, v) => {
      if (prev === prev && ts - prev > gapS) events.push([prev + 1e-3, d, null]);
      events.push([ts, d, v]);
      prev = ts;
    });
  });
  events.sort((a, b) => a[0] - b[0]);
  const x: number[] = [];
  const ys: Y[][] = seriesList.map(() => []);
  for (const [t, d, v] of events) {
    if (x.length === 0 || t !== x[x.length - 1]) {
      x.push(t);
      for (const y of ys) y.push(undefined);
    }
    ys[d]![x.length - 1] = v;
  }
  return { x, ys, mode: 'raw' };
}

function grid(seriesList: readonly DeviceSeries[], ch: SeriesChannel, t0: number, t1: number, buckets: number): ChartData {
  const bw = (t1 - t0) / buckets;
  const x: number[] = new Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    x[2 * b] = t0 + bw * (b + 0.25);
    x[2 * b + 1] = t0 + bw * (b + 0.75);
  }
  const minV = new Float64Array(buckets);
  const maxV = new Float64Array(buckets);
  const minT = new Float64Array(buckets);
  const maxT = new Float64Array(buckets);
  const firstT = new Float64Array(buckets);
  const lastT = new Float64Array(buckets);
  const count = new Uint32Array(buckets);
  const ys = seriesList.map((s) => {
    count.fill(0);
    s.forEachValue(ch, t0, t1, (ts, v) => {
      let b = Math.floor((ts - t0) / bw);
      if (b >= buckets) b = buckets - 1;
      if (count[b] === 0) {
        minV[b] = maxV[b] = v;
        minT[b] = maxT[b] = firstT[b] = ts;
      } else {
        if (v < minV[b]!) [minV[b], minT[b]] = [v, ts];
        if (v > maxV[b]!) [maxV[b], maxT[b]] = [v, ts];
      }
      lastT[b] = ts; // samples come in time order
      count[b]! += 1;
    });
    const gapS = gapThreshold(s, ch, t0, t1);
    const y: Y[] = new Array<Y>(buckets * 2).fill(undefined);
    // Gaps are measured between real neighbouring samples (last of one bucket, first of the next),
    // not from the times of the extremes, which can sit anywhere in a bucket.
    let prevT = -Infinity;
    for (let b = 0; b < buckets; b++) {
      if (count[b] === 0) continue;
      if (prevT > -Infinity && b > 0 && firstT[b]! - prevT > gapS) y[2 * b - 1] = null;
      prevT = lastT[b]!;
      if (count[b] === 1 || minV[b] === maxV[b]) y[2 * b] = minV[b]!;
      else if (minT[b]! <= maxT[b]!) {
        y[2 * b] = minV[b]!;
        y[2 * b + 1] = maxV[b]!;
      } else {
        y[2 * b] = maxV[b]!;
        y[2 * b + 1] = minV[b]!;
      }
    }
    return y;
  });
  return { x, ys, mode: 'grid' };
}
