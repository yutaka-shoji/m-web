import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS } from '../../../src/core/comfort/comfort';
import { openMWebDB } from '../../../src/core/data/db';
import {
  createDump,
  deleteDump,
  finishDump,
  listDumps,
  recoverAbandonedDumps,
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
