import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS } from '../../../src/core/comfort/comfort';
import { openMWebDB, type Db } from '../../../src/core/data/db';
import {
  createDump,
  deleteDump,
  finishDump,
  listDumps,
  recoverAbandonedDumps,
  reopenDump,
  saveDumpBlock,
} from '../../../src/core/data/dump-store';
import { exportDumpCsv } from '../../../src/core/export/export-dump';
import { MLoggerClient } from '../../../src/core/protocol/client';
import { runDump } from '../../../src/core/protocol/dump-job';
import { FakeFirmwareLink, makeRecords } from '../../helpers/fake-firmware';

describe('flash download → IndexedDB → CSV', () => {
  it('stores blocks as they arrive, resumes after an interruption, and exports every record', async () => {
    const db = await openMWebDB('dump-test-1');
    const records = makeRecords(2500);
    const fw = new FakeFirmwareLink({ records });
    const client = new MLoggerClient(fw, { gapMs: 1 });

    // first attempt: cancelled after the first block
    const ac = new AbortController();
    let meta = null as Awaited<ReturnType<typeof createDump>> | null;
    await runDump(client, {
      stallMs: 200,
      quietMs: 20,
      signal: ac.signal,
      onCount: async (info) => {
        meta = await createDump(db, {
          hardwareId: '3DF27622',
          name: 'MLogger_0001',
          firmware: '4.0.1',
          total: info.count,
          recordSize: info.record_size,
          blockRecords: 1000,
        });
      },
      onBlock: async (index, from, count, bytes) => {
        await saveDumpBlock(db, meta!.id, { index, from, count, bytes: bytes.slice() });
        if (index === 0) ac.abort();
      },
    }).catch(() => undefined);
    await finishDump(db, meta!.id, 'paused');
    const paused = (await listDumps(db))[0]!;
    expect(paused).toMatchObject({ status: 'paused', blocksDone: 1, total: 2500 });

    // resume from the next block
    await runDump(client, {
      startBlock: paused.blocksDone,
      expectTotal: paused.total,
      stallMs: 200,
      quietMs: 20,
      onBlock: (index, from, count, bytes) => saveDumpBlock(db, paused.id, { index, from, count, bytes: bytes.slice() }),
    });
    const done = await finishDump(db, paused.id, 'done');
    expect(done).toMatchObject({ status: 'done', blocksDone: 3 });

    const file = await exportDumpCsv(db, done!, { conditions: DEFAULT_CONDITIONS, voltage: false });
    const lines = file.parts.join('').split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(1 + 2500);
    // makeRecords(i=0): ts 1767225600 (2026-01-01 09:00:00 JST), t 20.00, g 21.00, h 50.00, co2 400
    expect(lines[1]).toBe('2026-01-01 09:00:00+09:00,1767225600,20.00,50.00,21.00,,,400,,,');
    expect(lines[2500]).toMatch(/^2026-01-01 12:28:15\+09:00,1767238095,/);
    expect(file.name).toMatch(/^MLogger_0001_3DF27622_flash_\d{8}-\d{4}\.csv$/);

    await deleteDump(db, done!.id);
    expect(await listDumps(db)).toHaveLength(0);
    client.dispose();
  });

  it('makes downloads left running by a closed page resumable, but not one still running', async () => {
    const db = await openMWebDB('dump-test-recover');
    const meta = { hardwareId: '3DF27622', name: 'MLogger_0001', firmware: '4.0.1', total: 2500, recordSize: 22, blockRecords: 1000 };
    const abandoned = await createDump(db, meta, 1_000);
    const live = await createDump(db, meta, 2_000);
    const done = await createDump(db, meta, 3_000);
    await finishDump(db, done.id, 'done');

    const recovered = await recoverAbandonedDumps(db, new Set([live.id]));
    expect(recovered.map((m) => m.id)).toEqual([abandoned.id]);
    const status = Object.fromEntries((await listDumps(db)).map((m) => [m.id, m.status]));
    expect(status).toEqual({ [abandoned.id]: 'paused', [live.id]: 'running', [done.id]: 'done' });
  });
});

describe('deleting and resuming one download in two tabs', () => {
  const META = { hardwareId: '3DF27622', name: 'MLogger_0001', firmware: '4.0.1', total: 3000, recordSize: 22, blockRecords: 1000 };
  const block = (index: number) => ({ index, from: index * 1000, count: 1000, bytes: new Uint8Array(22_000) });
  const blocksOf = (db: Db, id: string) => db.count('dumpBlocks', IDBKeyRange.bound([id, -Infinity], [id, Infinity]));

  /** Two connections to one database stand for two tabs. */
  async function twoTabs(name: string): Promise<[Db, Db]> {
    return [await openMWebDB(name), await openMWebDB(name)];
  }

  async function pausedDump(db: Db, blocks: number): Promise<string> {
    const m = await createDump(db, META);
    for (let i = 0; i < blocks; i++) await saveDumpBlock(db, m.id, block(i));
    await finishDump(db, m.id, 'paused');
    return m.id;
  }

  it('refuses to resume a download deleted in the other tab, and stores none of its blocks', async () => {
    const [a, b] = await twoTabs('dump-tabs-deleted');
    const id = await pausedDump(a, 1);
    expect(await deleteDump(b, id)).toBe(true);
    // Tab A's list still shows it as paused.
    await expect(reopenDump(a, id)).rejects.toThrow('deleted');
    await expect(saveDumpBlock(a, id, block(1))).rejects.toThrow('deleted');
    expect(await finishDump(a, id, 'failed', 'x')).toBeUndefined();
    expect(await a.get('dumps', id)).toBeUndefined();
    expect(await blocksOf(a, id)).toBe(0);
  });

  it('lets a resume and a deletion of the same download happen only one after the other', async () => {
    const [a, b] = await twoTabs('dump-tabs-race');
    // Resume first: the deletion is refused and every block stays.
    const kept = await pausedDump(a, 2);
    const [reopened, deleted] = await Promise.all([reopenDump(a, kept), deleteDump(b, kept)]);
    expect(reopened).toMatchObject({ status: 'running', blocksDone: 2 });
    expect(deleted).toBe(false);
    expect(await a.get('dumps', kept)).toMatchObject({ status: 'running', blocksDone: 2 });
    expect(await blocksOf(a, kept)).toBe(2);

    // Deletion first: the resume is refused and nothing comes back.
    const gone = await pausedDump(a, 2);
    const [deleted2, reopened2] = await Promise.allSettled([deleteDump(b, gone), reopenDump(a, gone)]);
    expect(deleted2).toEqual({ status: 'fulfilled', value: true });
    expect(reopened2.status).toBe('rejected');
    expect(await a.get('dumps', gone)).toBeUndefined();
    expect(await blocksOf(a, gone)).toBe(0);
  });
});
