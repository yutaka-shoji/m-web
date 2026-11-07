/**
 * Session → CSV text, streamed as string parts (runs in the export worker and in tests).
 */
import type { ComfortConditions } from '../comfort/comfort';
import { BOM, csvHeader, csvLine, csvText, LIVE_PRECISION, safeFileName } from '../data/csv';
import { iterateChunks, type Db, type SessionRecord } from '../data/db';
import type { SmpData } from '../protocol/types';
import { RowBuilder } from './rows';

export interface ExportOptions {
  conditions: ComfortConditions;
  voltage: boolean;
  /** One file per device (default) or all devices in one long file. */
  layout: 'per-device' | 'long';
  hardwareIds?: string[];
  onProgress?: (doneRows: number, totalRows: number) => void;
}

export interface ExportFile {
  name: string;
  parts: string[];
  rows: number;
}

const CH_NULL_BIT = { t: 1, h: 2, g: 4, v: 8, vv: 16, l: 32, c: 64 } as const;
const WU = { g: 1 << 8, v: 1 << 9, l: 1 << 10 } as const;
const DC = { g: 1 << 11, v: 1 << 12, l: 1 << 13 } as const;

function sampleOf(chunk: { [k: string]: unknown; flags: Uint16Array }, k: number): SmpData {
  const data: SmpData = {};
  const f = chunk.flags[k]!;
  for (const ch of ['t', 'h', 'g', 'v', 'vv', 'l', 'c'] as const) {
    const v = (chunk[ch] as Float32Array)[k]!;
    if (!Number.isNaN(v)) data[ch] = v;
    else if (f & CH_NULL_BIT[ch]) data[ch] = null;
  }
  const wu = (['g', 'v', 'l'] as const).filter((c) => f & WU[c]);
  const dc = (['g', 'v', 'l'] as const).filter((c) => f & DC[c]);
  if (wu.length) data.wu = wu;
  if (dc.length) data.dc = dc;
  return data;
}

/** Float32 storage → the decimal the device sent (e.g. 23.450000762 → 23.45 at 2 dp happens at format time). */
export async function exportSessionCsv(db: Db, session: SessionRecord, opts: ExportOptions): Promise<ExportFile[]> {
  const devices = session.devices.filter((d) => !opts.hardwareIds || opts.hardwareIds.includes(d.hardwareId));
  const total = devices.reduce((n, d) => n + d.samples, 0);
  const files: ExportFile[] = [];
  const header = csvHeader({ voltage: opts.voltage, long: opts.layout === 'long' });
  let done = 0;
  let longFile: ExportFile | null = null;
  if (opts.layout === 'long') {
    longFile = { name: `${safeFileName(session.title)}.csv`, parts: [BOM + header], rows: 0 };
    files.push(longFile);
  }
  for (const d of devices) {
    const file: ExportFile = longFile ?? {
      name: `${safeFileName(session.title)}_${safeFileName(d.name)}_${d.hardwareId}.csv`,
      parts: [BOM + header],
      rows: 0,
    };
    if (!longFile) files.push(file);
    const builder = new RowBuilder(d.settings, opts.conditions);
    const prefix = opts.layout === 'long' ? `${csvText(d.name)},${d.hardwareId},` : undefined;
    let buf = '';
    for await (const chunk of iterateChunks(db, session.id, d.hardwareId)) {
      for (let k = 0; k < chunk.n; k++) {
        const row = builder.row(chunk.ts[k]!, sampleOf(chunk as unknown as Parameters<typeof sampleOf>[0], k));
        if (!row) continue;
        buf += csvLine(row, LIVE_PRECISION, { voltage: opts.voltage, ...(prefix ? { prefix } : {}) });
        file.rows += 1;
        if (buf.length > 65536) {
          file.parts.push(buf);
          buf = '';
        }
      }
      done += chunk.n;
      opts.onProgress?.(done, total);
    }
    if (buf) file.parts.push(buf);
  }
  return files;
}

/** Metadata written next to the CSV files (calculation conditions, devices). */
export function sessionManifest(session: SessionRecord, opts: ExportOptions, appVersion: string): string {
  return JSON.stringify(
    {
      title: session.title,
      startedAt: new Date(session.startedAt).toISOString(),
      endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
      timeZone: session.tz,
      exportedBy: `m-web ${appVersion}`,
      comfort: {
        conditions: opts.conditions,
        mrt: 'ISO 7726 Annex B; globe D = 0.038 m, emissivity 0.95; larger of natural/forced convection',
        pmv: 'ISO 7730:2005 Annex D',
      },
      columns: 'datetime = device timestamp in local time; empty cell = not measured',
      devices: session.devices.map((d) => ({
        name: d.name,
        hardwareId: d.hardwareId,
        firmware: d.firmware,
        settings: d.settings,
        transports: d.transports,
        samples: d.samples,
      })),
    },
    null,
    2,
  );
}
