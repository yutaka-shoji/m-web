/**
 * Turns stored samples into CSV rows, recomputing MRT/PMV/PPD exactly as the live view does
 * (forward-filled display state + the same gating), with one extra rule for files: a value
 * older than 3 × its category interval (≥ 30 s) is not carried into the derived indices.
 */
import { computeComfort, type ComfortConditions } from '../comfort/comfort';
import { LiveTracker, type LiveState, type LiveValue } from '../device/live-tracker';
import { CATEGORY_SETTING, CHANNEL_CATEGORY, CHANNELS, type Channel } from '../device/quantities';
import type { Settings, SmpData } from '../protocol/types';
import type { CsvRow } from '../data/csv';

const NONE: LiveValue = { value: null, status: 'none', ts: 0 };

export function maxAges(settings: Settings | null): Record<Channel, number> {
  const out = {} as Record<Channel, number>;
  for (const ch of CHANNELS) {
    const iv = settings ? settings[CATEGORY_SETTING[CHANNEL_CATEGORY[ch]]].interval : 60;
    out[ch] = Math.max(30, 3 * iv);
  }
  return out;
}

function freshen(live: LiveState, ts: number, ages: Record<Channel, number>): LiveState {
  let changed = false;
  const values = { ...live.values };
  for (const ch of CHANNELS) {
    const v = values[ch];
    if (v.value !== null && ts - v.ts > ages[ch]) {
      values[ch] = NONE;
      changed = true;
    }
  }
  return changed ? { ...live, values } : live;
}

export class RowBuilder {
  private readonly tracker = new LiveTracker();
  private readonly ages: Record<Channel, number>;
  private readonly conditions: ComfortConditions;

  constructor(settings: Settings | null, conditions: ComfortConditions, ages?: Record<Channel, number>) {
    this.tracker.setSettings(settings);
    this.ages = ages ?? maxAges(settings);
    this.conditions = conditions;
  }

  /** Returns null when the sample carries no measured value at all. */
  row(ts: number, data: SmpData): CsvRow | null {
    const live = this.tracker.apply(ts, data, 0);
    const v = (ch: Channel) => {
      const x = data[ch];
      return typeof x === 'number' ? x : null;
    };
    const row: CsvRow = {
      ts,
      t: v('t'),
      h: v('h'),
      g: v('g'),
      v: v('v'),
      l: v('l'),
      c: v('c'),
      vv: v('vv'),
      mrt: null,
      pmv: null,
      ppd: null,
    };
    if (row.t === null && row.h === null && row.g === null && row.v === null && row.l === null && row.c === null) {
      return null;
    }
    const comfort = computeComfort(freshen(live, ts, this.ages), this.conditions);
    row.mrt = comfort.mrt;
    row.pmv = comfort.pmv;
    row.ppd = comfort.ppd;
    return row;
  }
}
