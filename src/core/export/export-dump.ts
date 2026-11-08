/**
 * Flash download → CSV (same columns as the PC recordings, flash-record precision).
 * Records stay in write order (the device clock may have been reset between sessions, so
 * timestamps are not necessarily monotonic); the comfort state is reset whenever time goes back.
 */
import type { ComfortConditions } from '../comfort/comfort';
import { BOM, csvHeader, csvLine, FLASH_PRECISION, safeFileName } from '../data/csv';
import type { Db, DumpRecordMeta } from '../data/db';
import { iterateDumpBlocks } from '../data/dump-store';
import { CHANNELS, type Channel } from '../device/quantities';
import { decodeRecord, emptyRecord, RECORD_SIZE } from '../protocol/record';
import type { SmpData } from '../protocol/types';
import type { ExportFile } from './export-session';
import { RowBuilder } from './rows';

export interface DumpExportOptions {
  conditions: ComfortConditions;
  voltage: boolean;
  onProgress?: (done: number, total: number) => void;
}

/** Per-channel typical step (median of the first few hundred intervals), for the stale rule. */
async function estimateMaxAges(db: Db, dumpId: string): Promise<Record<Channel, number>> {
  const last: Partial<Record<Channel, number>> = {};
  const steps: Record<Channel, number[]> = { t: [], h: [], g: [], v: [], vv: [], l: [], c: [] };
  const rec = emptyRecord();
  outer: for await (const block of iterateDumpBlocks(db, dumpId)) {
    const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength);
    for (let k = 0; k < block.count; k++) {
      decodeRecord(view, k * RECORD_SIZE, rec);
      for (const ch of CHANNELS) {
        if (rec[ch] === null) continue;
        const prev = last[ch];
        if (prev !== undefined && rec.ts > prev && steps[ch].length < 300) steps[ch].push(rec.ts - prev);
        last[ch] = rec.ts;
      }
      if (CHANNELS.every((ch) => steps[ch].length >= 300)) break outer;
    }
  }
  const out = {} as Record<Channel, number>;
  for (const ch of CHANNELS) {
    const s = steps[ch].sort((a, b) => a - b);
    out[ch] = Math.max(30, 3 * (s.length ? s[s.length >> 1]! : 60));
  }
  return out;
}

export function dumpFileName(meta: DumpRecordMeta): string {
  const d = new Date(meta.startedAt);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `${safeFileName(meta.name)}_${meta.hardwareId}_flash_${stamp}.csv`;
}

export async function exportDumpCsv(db: Db, meta: DumpRecordMeta, opts: DumpExportOptions): Promise<ExportFile> {
  const ages = await estimateMaxAges(db, meta.id);
  const file: ExportFile = {
    name: dumpFileName(meta),
    parts: [BOM + csvHeader({ voltage: opts.voltage, long: false })],
    rows: 0,
  };
  let builder = new RowBuilder(null, opts.conditions, ages);
  let lastTs = -Infinity;
  let buf = '';
  let done = 0;
  const rec = emptyRecord();
  for await (const block of iterateDumpBlocks(db, meta.id)) {
    const view = new DataView(block.bytes.buffer, block.bytes.byteOffset, block.bytes.byteLength);
    for (let k = 0; k < block.count; k++) {
      decodeRecord(view, k * RECORD_SIZE, rec);
      if (rec.ts < lastTs) builder = new RowBuilder(null, opts.conditions, ages); // clock went back
      lastTs = rec.ts;
      const data: SmpData = {};
      for (const ch of CHANNELS) if (rec[ch] !== null) data[ch] = rec[ch];
      const row = builder.row(rec.ts, data);
      if (!row) continue;
      buf += csvLine(row, FLASH_PRECISION, { voltage: opts.voltage });
      file.rows += 1;
      if (buf.length > 65536) {
        file.parts.push(buf);
        buf = '';
      }
    }
    done += block.count;
    opts.onProgress?.(done, meta.total);
  }
  if (buf) file.parts.push(buf);
  return file;
}
