import { defineStore } from 'pinia';
import { reactive, shallowRef } from 'vue';
import type { DumpRecordMeta } from '../../core/data/db';
import {
  createDump,
  deleteDump,
  finishDump,
  listDumps,
  recoverAbandonedDumps,
  reopenDump,
  saveDumpBlock,
} from '../../core/data/dump-store';
import { runDump, type DumpProgress } from '../../core/protocol/dump-job';
import { AbortedError } from '../../core/protocol/errors';
import { ownsDeviceWork } from '../composables/useAppStatus';
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

  /** Ids of the downloads this page is running. */
  function runningHere(): Set<string> {
    return new Set(Object.values(jobs).flatMap((j) => (j.dumpId && !j.done ? [j.dumpId] : [])));
  }

  // A download left 'running' by a reloaded or closed page cannot be resumed until it is marked
  // 'paused'. Only the tab that holds the devices can be downloading, so it alone does this.
  let recovered: Promise<void> | null = null;
  function recoverOnce(): Promise<void> {
    recovered ??= (async () => {
      if (await ownsDeviceWork()) await recoverAbandonedDumps(await getDb(), runningHere());
    })().catch(() => {
      recovered = null; // try again on the next refresh
    });
    return recovered;
  }

  async function refresh(): Promise<void> {
    await recoverOnce();
    list.value = await listDumps(await getDb());
  }

  /** Download the device's flash log (the device must not be logging). */
  async function start(entry: DeviceEntry, resume?: DumpRecordMeta): Promise<void> {
    const ctrl = entry.controller;
    const client = ctrl.protocolClient;
    const meta0 = ctrl.snapshot.meta;
    if (!client || !meta0.hardwareId) throw new Error('logger not connected');
    if (!(await ownsDeviceWork())) throw new Error('another tab holds the loggers');
    const db = await getDb();
    // Recovery first: run later, it would take the claimed download (not yet among the jobs) for
    // an abandoned one and mark it 'paused'.
    await recoverOnce();
    // Claimed before the logger is asked anything: a download deleted meanwhile (here or in a tab
    // whose list this one does not see) is refused, and once claimed it can't be deleted.
    const resumed = resume
      ? await reopenDump(db, resume.id).catch(async (err: unknown) => {
          await refresh(); // the list was out of date
          throw err;
        })
      : null;
    const job: DumpJob = { dumpId: resumed?.id ?? null, total: resumed?.total ?? 0, progress: null, error: null, done: false, abort: new AbortController() };
    jobs[entry.key] = job;
    const live = jobs[entry.key]!; // reactive proxy
    ctrl.setOp('dump');
    ctrl.keepAlive = true;
    let dumpId = resumed?.id ?? null;
    try {
      await runDump(client, {
        ...(resumed ? { startBlock: resumed.blocksDone, expectTotal: resumed.total } : {}),
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
    // Refused while a job (in this or the other tab) is writing the download's blocks.
    await deleteDump(await getDb(), id);
    await refresh();
  }

  return { list, jobs, refresh, start, cancel, exportCsv, remove };
});
