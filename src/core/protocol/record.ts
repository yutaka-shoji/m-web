/**
 * Flash record layout (`dump`, 22 bytes, little-endian "<BIBIhhHHHH"), from firmware
 * w25q256.h SensorData_t and MLLib DumpDecoder.cs. A field is valid only if its flag bit
 * is set (no sentinel values). Corrections are already applied by the firmware.
 */
export const RECORD_SIZE = 22;
export const RECORD_FORMAT = '<BIBIhhHHHH';

export const FLAG_ILLUMINANCE = 1 << 0;
export const FLAG_T_DRY = 1 << 1;
export const FLAG_T_GLB = 1 << 2;
export const FLAG_HUMIDITY = 1 << 3;
export const FLAG_WIND = 1 << 4;
export const FLAG_VOLTAGE = 1 << 5;
export const FLAG_CO2 = 1 << 6;

export interface DumpRecord {
  gen: number;
  /** Unix seconds (UTC). */
  ts: number;
  /** °C */
  t: number | null;
  /** % */
  h: number | null;
  /** °C */
  g: number | null;
  /** m/s */
  v: number | null;
  /** lx */
  l: number | null;
  /** ppm */
  c: number | null;
  /** Velocity probe bridge voltage, mV. */
  vv: number | null;
}

export function emptyRecord(): DumpRecord {
  return { gen: 0, ts: 0, t: null, h: null, g: null, v: null, l: null, c: null, vv: null };
}

/** Decode the record at byte offset `off`. Reuses `out` to avoid allocation in tight loops. */
export function decodeRecord(view: DataView, off: number, out: DumpRecord = emptyRecord()): DumpRecord {
  const flags = view.getUint8(off + 5);
  out.gen = view.getUint8(off);
  out.ts = view.getUint32(off + 1, true);
  out.l = flags & FLAG_ILLUMINANCE ? view.getUint32(off + 6, true) / 10 : null;
  out.t = flags & FLAG_T_DRY ? view.getInt16(off + 10, true) / 100 : null;
  out.g = flags & FLAG_T_GLB ? view.getInt16(off + 12, true) / 100 : null;
  out.h = flags & FLAG_HUMIDITY ? view.getUint16(off + 14, true) / 100 : null;
  out.v = flags & FLAG_WIND ? view.getUint16(off + 16, true) / 10000 : null;
  out.vv = flags & FLAG_VOLTAGE ? view.getUint16(off + 18, true) : null;
  out.c = flags & FLAG_CO2 ? view.getUint16(off + 20, true) : null;
  return out;
}

export function decodeRecords(bytes: Uint8Array): DumpRecord[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.length / RECORD_SIZE);
  const out: DumpRecord[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = decodeRecord(view, i * RECORD_SIZE);
  return out;
}
