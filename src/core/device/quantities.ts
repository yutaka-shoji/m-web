/** Measured quantities, keyed by the short smp keys. */
export type Quantity = 't' | 'h' | 'g' | 'v' | 'l' | 'c';
export const QUANTITIES: readonly Quantity[] = ['t', 'h', 'g', 'v', 'l', 'c'];

/** All per-sample channels kept in series/storage (vv = velocity probe voltage, diagnostic). */
export type Channel = Quantity | 'vv';
export const CHANNELS: readonly Channel[] = ['t', 'h', 'g', 'v', 'l', 'c', 'vv'];

export type CategoryId = 'g' | 'v' | 'l';

/** smp category id that produces each channel (protocol v4 §5.2). */
export const CHANNEL_CATEGORY: Readonly<Record<Channel, CategoryId>> = {
  t: 'g',
  h: 'g',
  g: 'g',
  c: 'g',
  v: 'v',
  vv: 'v',
  l: 'l',
};

/** Settings category of each smp category id. */
export const CATEGORY_SETTING = { g: 'general', v: 'velocity', l: 'illuminance' } as const;

export const UNITS: Readonly<Record<Channel, string>> = {
  t: '°C',
  h: '%',
  g: '°C',
  v: 'm/s',
  l: 'lx',
  c: 'ppm',
  vv: 'mV',
};

/** Decimal places for live display (official app: t/g F1, RH F0, v F2, lux/CO2 integers). */
export const DISPLAY_DECIMALS: Readonly<Record<Channel, number>> = {
  t: 1,
  h: 0,
  g: 1,
  v: 2,
  l: 0,
  c: 0,
  vv: 0,
};
