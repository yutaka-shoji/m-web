/**
 * Latest value per quantity with the display rules of the official app
 * (MLS_Mobile DataReceiveViewModel.cs):
 *  - key present with a number → show it (even during warm-up)
 *  - key present with null     → invalid reading
 *  - key absent, category in `dc` → probe disconnected ("—")
 *  - key absent, category in `wu` → warming up ("—"), except the globe temperature, which has
 *    its own sensor and is only cleared by `dc`
 *  - key absent otherwise → keep the previous value (sensor simply not due this tick)
 * Disabled categories (from get_settings) are reported as `off`.
 */
import type { Settings, SmpData } from '../protocol/types';
import { CATEGORY_SETTING, CHANNEL_CATEGORY, CHANNELS, type Channel } from './quantities';

export type ValueStatus = 'ok' | 'warming' | 'disconnected' | 'off' | 'invalid' | 'none';

export interface LiveValue {
  readonly value: number | null;
  readonly status: ValueStatus;
  /** Device timestamp (unix s) of the last update of this value. */
  readonly ts: number;
}

export interface LiveState {
  readonly values: Readonly<Record<Channel, LiveValue>>;
  /** Device timestamp of the newest sample (unix s), 0 if none. */
  readonly lastTs: number;
  /** PC arrival time of the newest sample (ms), 0 if none. */
  readonly lastReceivedAt: number;
  readonly warmingUp: readonly string[];
  readonly disconnected: readonly string[];
}

const NONE: LiveValue = Object.freeze({ value: null, status: 'none', ts: 0 });

export function emptyLiveState(): LiveState {
  const values = {} as Record<Channel, LiveValue>;
  for (const ch of CHANNELS) values[ch] = NONE;
  return Object.freeze({ values: Object.freeze(values), lastTs: 0, lastReceivedAt: 0, warmingUp: [], disconnected: [] });
}

export class LiveTracker {
  private state: LiveState = emptyLiveState();
  private settings: Settings | null = null;

  get current(): LiveState {
    return this.state;
  }

  setSettings(settings: Settings | null): void {
    this.settings = settings;
    this.state = this.withOffFlags(this.state);
  }

  reset(): void {
    this.state = this.withOffFlags(emptyLiveState());
  }

  /** Apply one smp event; returns the new immutable state. */
  apply(ts: number, data: SmpData, receivedAt: number): LiveState {
    const wu = new Set(data.wu ?? []);
    const dc = new Set(data.dc ?? []);
    const prev = this.state.values;
    const next = {} as Record<Channel, LiveValue>;
    for (const ch of CHANNELS) {
      const cat = CHANNEL_CATEGORY[ch];
      if (ch in data) {
        const v = data[ch];
        next[ch] = typeof v === 'number' ? { value: v, status: 'ok', ts } : { value: null, status: 'invalid', ts };
      } else if (dc.has(cat)) {
        next[ch] = { value: null, status: 'disconnected', ts };
      } else if (wu.has(cat) && ch !== 'g') {
        next[ch] = { value: null, status: 'warming', ts };
      } else {
        next[ch] = prev[ch];
      }
    }
    this.state = this.withOffFlags({
      values: next,
      lastTs: Math.max(ts, this.state.lastTs),
      lastReceivedAt: receivedAt,
      warmingUp: [...wu],
      disconnected: [...dc],
    });
    return this.state;
  }

  private withOffFlags(s: LiveState): LiveState {
    const values = { ...s.values } as Record<Channel, LiveValue>;
    if (this.settings) {
      for (const ch of CHANNELS) {
        const enabled = this.settings[CATEGORY_SETTING[CHANNEL_CATEGORY[ch]]].enabled;
        if (!enabled) values[ch] = { value: null, status: 'off', ts: values[ch].ts };
        else if (values[ch].status === 'off') values[ch] = NONE;
      }
    }
    for (const ch of CHANNELS) Object.freeze(values[ch]);
    return Object.freeze({ ...s, values: Object.freeze(values) });
  }
}
