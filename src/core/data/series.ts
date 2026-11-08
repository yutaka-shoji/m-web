/**
 * In-memory time series of one device, column-oriented in typed arrays and kept out of
 * Vue's reactivity. A ring buffer bounds memory (the full record lives in IndexedDB).
 *
 * - raw channels: NaN = key absent in that sample
 * - flags: explicit nulls and the sample's wu/dc categories, so the display/comfort logic can
 *   be replayed exactly (e.g. after the clo/met conditions change)
 * - derived channels (mrt/pmv/ppd): written by the comfort engine, NaN when not computable
 * `version` increments on every change so views can poll cheaply.
 */
import { CHANNELS, type Channel } from '../device/quantities';
import type { SensorCategoryId, SmpData } from '../protocol/types';

export type DerivedChannel = 'mrt' | 'pmv' | 'ppd';
export const DERIVED_CHANNELS: readonly DerivedChannel[] = ['mrt', 'pmv', 'ppd'];
export type SeriesChannel = Channel | DerivedChannel;

const NULL_BIT: Readonly<Record<Channel, number>> = { t: 1, h: 2, g: 4, v: 8, vv: 16, l: 32, c: 64 };
const WU_BIT: Readonly<Record<SensorCategoryId, number>> = { g: 1 << 8, v: 1 << 9, l: 1 << 10 };
const DC_BIT: Readonly<Record<SensorCategoryId, number>> = { g: 1 << 11, v: 1 << 12, l: 1 << 13 };
const CATS: readonly SensorCategoryId[] = ['g', 'v', 'l'];

export function encodeFlags(data: SmpData): number {
  let f = 0;
  for (const ch of CHANNELS) if (ch in data && data[ch] === null) f |= NULL_BIT[ch];
  for (const c of data.wu ?? []) f |= WU_BIT[c];
  for (const c of data.dc ?? []) f |= DC_BIT[c];
  return f;
}

export interface SeriesView {
  /** Unix seconds, ascending. */
  ts: Float64Array;
  cols: Partial<Record<SeriesChannel, Float32Array>>;
  length: number;
}

export class DeviceSeries {
  readonly capacity: number;
  private readonly ts: Float64Array;
  private readonly cols: Record<SeriesChannel, Float32Array>;
  private readonly flags: Uint16Array;
  private start = 0;
  private len = 0;
  version = 0;

  constructor(capacity = 200_000) {
    this.capacity = capacity;
    this.ts = new Float64Array(capacity);
    this.flags = new Uint16Array(capacity);
    this.cols = {} as Record<SeriesChannel, Float32Array>;
    for (const ch of [...CHANNELS, ...DERIVED_CHANNELS]) this.cols[ch] = new Float32Array(capacity).fill(NaN);
  }

  get length(): number {
    return this.len;
  }

  get firstTs(): number {
    return this.len ? this.ts[this.start]! : NaN;
  }

  get lastTs(): number {
    return this.len ? this.ts[this.ring(this.len - 1)]! : NaN;
  }

  private ring(k: number): number {
    return (this.start + k) % this.capacity;
  }

  /** Append a sample; returns false (ignored) if it is older than the newest one. */
  append(ts: number, data: SmpData): boolean {
    if (this.len > 0 && ts < this.lastTs) return false; // device clock went back: keep charts monotonic
    let i: number;
    if (this.len < this.capacity) {
      i = this.ring(this.len);
      this.len += 1;
    } else {
      i = this.start;
      this.start = (this.start + 1) % this.capacity;
    }
    this.ts[i] = ts;
    for (const ch of CHANNELS) {
      const v = data[ch];
      this.cols[ch][i] = typeof v === 'number' ? v : NaN;
    }
    for (const ch of DERIVED_CHANNELS) this.cols[ch][i] = NaN;
    this.flags[i] = encodeFlags(data);
    this.version += 1;
    return true;
  }

  /** Set derived values of the k-th sample (0 = oldest). */
  setDerived(k: number, mrt: number | null, pmv: number | null, ppd: number | null): void {
    if (k < 0 || k >= this.len) return;
    const i = this.ring(k);
    this.cols.mrt[i] = mrt ?? NaN;
    this.cols.pmv[i] = pmv ?? NaN;
    this.cols.ppd[i] = ppd ?? NaN;
  }

  /** Signal that derived values were rewritten (after a recompute). */
  touch(): void {
    this.version += 1;
  }

  /** Reconstruct the k-th sample as received (for replays). */
  sample(k: number): { ts: number; data: SmpData } {
    const i = this.ring(k);
    const f = this.flags[i]!;
    const data: SmpData = {};
    for (const ch of CHANNELS) {
      const v = this.cols[ch][i]!;
      if (!Number.isNaN(v)) data[ch] = v;
      else if (f & NULL_BIT[ch]) data[ch] = null;
    }
    const wu = CATS.filter((c) => f & WU_BIT[c]);
    const dc = CATS.filter((c) => f & DC_BIT[c]);
    if (wu.length) data.wu = wu;
    if (dc.length) data.dc = dc;
    return { ts: this.ts[i]!, data };
  }

  clear(): void {
    this.start = 0;
    this.len = 0;
    this.version += 1;
  }

  /** Index (0 = oldest) of the first sample with ts >= t. */
  lowerBound(t: number): number {
    let lo = 0;
    let hi = this.len;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ts[this.ring(mid)]! < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Number of samples (any channel) with t0 <= ts <= t1 — an upper bound for one channel. */
  countInRange(t0: number, t1: number): number {
    return Math.max(0, this.lowerBound(t1 + 1e-9) - this.lowerBound(t0));
  }

  /**
   * Visit samples of one channel in [t0, t1] that carry a value, in time order, without
   * allocating. Returning `false` from the callback stops the walk.
   */
  forEachValue(ch: SeriesChannel, t0: number, t1: number, cb: (ts: number, v: number) => boolean | void): void {
    const a = this.lowerBound(t0);
    const b = this.lowerBound(t1 + 1e-9);
    const col = this.cols[ch];
    const cap = this.capacity;
    let i = (this.start + a) % cap;
    for (let k = a; k < b; k++) {
      const v = col[i]!;
      if (v === v && cb(this.ts[i]!, v) === false) return; // v === v: not NaN
      i += 1;
      if (i === cap) i = 0;
    }
  }

  /** Contiguous copy of samples with t0 <= ts <= t1 for the requested channels. */
  window(t0: number, t1: number, channels: readonly SeriesChannel[]): SeriesView {
    const a = this.lowerBound(t0);
    const b = this.lowerBound(t1 + 1e-9);
    const n = Math.max(0, b - a);
    const ts = new Float64Array(n);
    const cols: Partial<Record<SeriesChannel, Float32Array>> = {};
    for (const ch of channels) cols[ch] = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const i = this.ring(a + k);
      ts[k] = this.ts[i]!;
      for (const ch of channels) cols[ch]![k] = this.cols[ch][i]!;
    }
    return { ts, cols, length: n };
  }
}
