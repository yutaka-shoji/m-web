import { defineStore } from 'pinia';
import { reactive, shallowRef } from 'vue';
import type { DumpRecordMeta } from '../../core/data/db';
import { createDump, deleteDump, finishDump, listDumps, saveDumpBlock } from '../../core/data/dump-store';
import { runDump, type DumpProgress } from '../../core/protocol/dump-job';
import { AbortedError } from '../../core/protocol/errors';
import { getDb } from '../db';
import { downloadBlob, runExport } from '../export';
import type { DeviceEntry } from './devices';
import { useSettingsStore } from './settings';

export interface DumpJob {
  dumpId: string | null;
  total: number;
  progress: DumpProgress | null;
  error: string | null;
  done: boolean;
  abort: AbortController;
}

export const useDumpsStore = defineStore('dumps', () => {
  const settings = useSettingsStore();
  const list = shallowRef<DumpRecordMeta[]>([]);
  /** Running/finished jobs per device key (this page session). */
  const jobs = reactive<Record<string, DumpJob>>({});

  async function refresh(): Promise<void> {
    list.value = await listDumps(await getDb());
  }

  /** Download the device's flash log (the device must not be logging). */
  async function start(entry: DeviceEntry, resume?: DumpRecordMeta): Promise<void> {
    const ctrl = entry.controller;
    const client = ctrl.protocolClient;
    const meta0 = ctrl.snapshot.meta;
    if (!client || !meta0.hardwareId) throw new Error('logger not connected');
    const db = await getDb();
    const job: DumpJob = { dumpId: resume?.id ?? null, total: resume?.total ?? 0, progress: null, error: null, done: false, abort: new AbortController() };
    jobs[entry.key] = job;
    const live = jobs[entry.key]!; // reactive proxy
    ctrl.setOp('dump');
    ctrl.keepAlive = true;
    let dumpId = resume?.id ?? null;
    try {
      await runDump(client, {
        ...(resume ? { startBlock: resume.blocksDone, expectTotal: resume.total } : {}),
        signal: job.abort.signal,
        onCount: async (info) => {
          live.total = info.count;
          if (!dumpId) {
            const m = await createDump(db, {
              hardwareId: meta0.hardwareId!,
              name: meta0.name ?? meta0.hardwareId!,
              firmware: meta0.firmware,
              total: info.count,
              recordSize: info.record_size,
              blockRecords: 1000,
            });
            dumpId = m.id;
            live.dumpId = m.id;
          } else {
            await finishDump(db, dumpId, 'running');
          }
          await refresh();
        },
        onBlock: (index, from, count, bytes) => saveDumpBlock(db, dumpId!, { index, from, count, bytes: bytes.slice() }),
        onProgress: (p) => (live.progress = { ...p }),
      });
      if (dumpId) await finishDump(db, dumpId, 'done');
      live.done = true;
    } catch (err) {
      const aborted = err instanceof AbortedError || job.abort.signal.aborted;
      live.error = aborted ? null : err instanceof Error ? err.message : String(err);
      if (dumpId) await finishDump(db, dumpId, aborted ? 'paused' : 'failed', live.error);
      if (!aborted) throw err;
    } finally {
      ctrl.setOp(null);
      ctrl.keepAlive = false;
      await refresh();
    }
  }

  function cancel(key: string): void {
    jobs[key]?.abort.abort();
  }

  async function exportCsv(meta: DumpRecordMeta, voltage = false): Promise<number> {
    const res = await runExport({ kind: 'dump', dumpId: meta.id, options: { conditions: { ...settings.conditions }, voltage } });
    downloadBlob(res.blob, res.filename);
    return res.rows;
  }

  async function remove(id: string): Promise<void> {
    await deleteDump(await getDb(), id);
    await refresh();
  }

  return { list, jobs, refresh, start, cancel, exportCsv, remove };
});
