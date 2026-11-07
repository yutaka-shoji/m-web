/// <reference lib="webworker" />
/**
 * Export worker: reads a session from IndexedDB and builds the CSV (or a ZIP of CSVs plus
 * session.json) off the main thread. ZIP output is streamed, so memory follows the
 * compressed size.
 */
import { Zip, ZipDeflate, strToU8 } from 'fflate';
import { safeFileName } from '../data/csv';
import { openMWebDB } from '../data/db';
import { exportDumpCsv, type DumpExportOptions } from './export-dump';
import { exportSessionCsv, sessionManifest, type ExportOptions } from './export-session';

export type ExportRequest =
  | {
      kind: 'session';
      sessionId: string;
      options: Omit<ExportOptions, 'onProgress'>;
      zip: boolean;
      appVersion: string;
    }
  | { kind: 'dump'; dumpId: string; options: Omit<DumpExportOptions, 'onProgress'> };

export type ExportMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'done'; blob: Blob; filename: string; rows: number }
  | { type: 'error'; message: string };

declare const self: DedicatedWorkerGlobalScope;
const post = (m: ExportMessage) => self.postMessage(m);

function zipFiles(files: Array<{ name: string; parts: string[] }>): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const out: Uint8Array[] = [];
    const zip = new Zip((err, data, final) => {
      if (err) return reject(err);
      out.push(data);
      if (final) resolve(new Blob(out as BlobPart[], { type: 'application/zip' }));
    });
    for (const f of files) {
      const entry = new ZipDeflate(f.name, { level: 6 });
      zip.add(entry);
      for (const part of f.parts) entry.push(strToU8(part));
      entry.push(new Uint8Array(0), true);
    }
    zip.end();
  });
}

self.onmessage = async (ev: MessageEvent<ExportRequest>) => {
  const req = ev.data;
  try {
    const db = await openMWebDB();
    let lastPost = 0;
    const onProgress = (done: number, total: number) => {
      const now = Date.now();
      if (now - lastPost > 150) {
        lastPost = now;
        post({ type: 'progress', done, total });
      }
    };
    if (req.kind === 'dump') {
      const meta = await db.get('dumps', req.dumpId);
      if (!meta) throw new Error('download not found');
      const f = await exportDumpCsv(db, meta, { ...req.options, onProgress });
      post({ type: 'done', blob: new Blob(f.parts, { type: 'text/csv;charset=utf-8' }), filename: f.name, rows: f.rows });
      db.close();
      return;
    }
    const session = await db.get('sessions', req.sessionId);
    if (!session) throw new Error('session not found');
    const files = await exportSessionCsv(db, session, { ...req.options, onProgress });
    const rows = files.reduce((n, f) => n + f.rows, 0);
    if (!req.zip && files.length === 1) {
      const f = files[0]!;
      post({ type: 'done', blob: new Blob(f.parts, { type: 'text/csv;charset=utf-8' }), filename: f.name, rows });
    } else {
      const manifest = { name: 'session.json', parts: [sessionManifest(session, req.options, req.appVersion)] };
      const blob = await zipFiles([...files, manifest]);
      post({ type: 'done', blob, filename: `${safeFileName(session.title)}.zip`, rows });
    }
    db.close();
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
