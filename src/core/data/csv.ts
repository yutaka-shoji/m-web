/**
 * CSV layout (one header row, English column names with units; datetime = device timestamp in
 * the PC's local time with its UTC offset; empty cell = not measured; UTF-8 with BOM; CRLF).
 */
export const CSV_COLUMNS = [
  'datetime',
  'unix_time',
  't_dry[C]',
  'rh[%]',
  't_glb[C]',
  'velocity[m/s]',
  'illuminance[lx]',
  'co2[ppm]',
  'mrt[C]',
  'pmv',
  'ppd[%]',
] as const;

export const CSV_VOLTAGE_COLUMN = 'velocity_voltage[mV]';
export const CSV_LONG_PREFIX = ['device', 'hardware_id'] as const;
export const BOM = '﻿';
export const EOL = '\r\n';

export interface CsvRow {
  ts: number;
  t: number | null;
  h: number | null;
  g: number | null;
  v: number | null;
  l: number | null;
  c: number | null;
  vv: number | null;
  mrt: number | null;
  pmv: number | null;
  ppd: number | null;
}

export type Precision = Readonly<Record<Exclude<keyof CsvRow, 'ts'>, number>>;

/** Live (smp) data: the firmware's own rounding (protocol v4 §5.2). */
export const LIVE_PRECISION: Precision = { t: 2, h: 1, g: 2, v: 3, l: 0, c: 0, vv: 0, mrt: 2, pmv: 3, ppd: 1 };
/** Flash records: resolution of the 22-byte record (load_data.py). */
export const FLASH_PRECISION: Precision = { t: 2, h: 2, g: 2, v: 4, l: 1, c: 0, vv: 0, mrt: 2, pmv: 3, ppd: 1 };

export function csvHeader(opts: { voltage: boolean; long: boolean }): string {
  const cols: string[] = [...(opts.long ? CSV_LONG_PREFIX : []), ...CSV_COLUMNS];
  if (opts.voltage) cols.push(CSV_VOLTAGE_COLUMN);
  return cols.join(',') + EOL;
}

const pad2 = (n: number) => (n < 10 ? '0' : '') + n;

/**
 * "YYYY-MM-DD HH:mm:ss+09:00": local time of the runtime's time zone followed by its UTC offset at
 * that instant (RFC 3339 with a space separator), so rows stay unambiguous across DST changes.
 */
export function localDateTime(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const east = -d.getTimezoneOffset(); // minutes east of UTC
  const a = Math.abs(east);
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}` +
    `${east < 0 ? '-' : '+'}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`
  );
}

function num(v: number | null, digits: number): string {
  if (v === null || !Number.isFinite(v)) return '';
  const s = v.toFixed(digits);
  return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s;
}

/** RFC 4180 quoting for free text (device names). */
export function csvText(s: string): string {
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(
  row: CsvRow,
  p: Precision,
  opts: { voltage: boolean; prefix?: string },
): string {
  let line =
    (opts.prefix ?? '') +
    localDateTime(row.ts) +
    ',' +
    row.ts +
    ',' +
    num(row.t, p.t) +
    ',' +
    num(row.h, p.h) +
    ',' +
    num(row.g, p.g) +
    ',' +
    num(row.v, p.v) +
    ',' +
    num(row.l, p.l) +
    ',' +
    num(row.c, p.c) +
    ',' +
    num(row.mrt, p.mrt) +
    ',' +
    num(row.pmv, p.pmv) +
    ',' +
    num(row.ppd, p.ppd);
  if (opts.voltage) line += ',' + num(row.vv, p.vv);
  return line + EOL;
}

/** File-name-safe text (keeps Japanese characters). */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').replace(/\s+/g, '_').slice(0, 80) || 'data';
}
