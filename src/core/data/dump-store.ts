/**
 * Flash downloads in IndexedDB: the raw 22-byte records are kept per 1000-record block
 * (the source of truth; decoding happens at export), so an interrupted download can be
 * resumed from the next missing block.
 */
import { newId, type Db, type DumpBlockRecord, type DumpRecordMeta } from './db';

export async function createDump(
  db: Db,
  meta: Pick<DumpRecordMeta, 'hardwareId' | 'name' | 'firmware' | 'total' | 'recordSize' | 'blockRecords'>,
  now = Date.now(),
): Promise<DumpRecordMeta> {
  const rec: DumpRecordMeta = {
    ...meta,
    id: newId(now),
    startedAt: now,
    finishedAt: null,
    blocksDone: 0,
    status: 'running',
    error: null,
  };
  await db.put('dumps', rec);
  return rec;
}

/** Store one block and advance `blocksDone` in the same transaction. */
export async function saveDumpBlock(db: Db, dumpId: string, block: Omit<DumpBlockRecord, 'dumpId'>): Promise<void> {
  const tx = db.transaction(['dumpBlocks', 'dumps'], 'readwrite');
  await tx.objectStore('dumpBlocks').put({ dumpId, ...block });
  const meta = await tx.objectStore('dumps').get(dumpId);
  if (meta) {
    meta.blocksDone = Math.max(meta.blocksDone, block.index + 1);
    await tx.objectStore('dumps').put(meta);
  }
  await tx.done;
}

export async function finishDump(
  db: Db,
  dumpId: string,
  status: DumpRecordMeta['status'],
  error: string | null = null,
  now = Date.now(),
): Promise<DumpRecordMeta | undefined> {
  const meta = await db.get('dumps', dumpId);
  if (!meta) return undefined;
  meta.status = status;
  meta.error = error;
  if (status === 'done') meta.finishedAt = now;
  await db.put('dumps', meta);
  return meta;
}

/**
 * Downloads still marked 'running' although no job runs them any more (the page was reloaded or
 * closed mid-download) become 'paused', so they can be resumed. `running` = ids of the jobs that
 * do still run. Call only where no other tab can be downloading.
 */
export async function recoverAbandonedDumps(db: Db, running: ReadonlySet<string> = new Set()): Promise<DumpRecordMeta[]> {
  const out: DumpRecordMeta[] = [];
  for (const meta of await db.getAll('dumps')) {
    if (meta.status !== 'running' || running.has(meta.id)) continue;
    meta.status = 'paused';
    await db.put('dumps', meta);
    out.push(meta);
  }
  return out;
}

export async function listDumps(db: Db): Promise<DumpRecordMeta[]> {
  return (await db.getAll('dumps')).sort((a, b) => b.startedAt - a.startedAt);
}

export async function* iterateDumpBlocks(db: Db, dumpId: string): AsyncGenerator<DumpBlockRecord> {
  const range = IDBKeyRange.bound([dumpId, -Infinity], [dumpId, Infinity]);
  let cursor = await db.transaction('dumpBlocks').store.openCursor(range);
  while (cursor) {
    yield cursor.value;
    cursor = await cursor.continue();
  }
}

export async function deleteDump(db: Db, dumpId: string): Promise<void> {
  const tx = db.transaction(['dumpBlocks', 'dumps'], 'readwrite');
  const range = IDBKeyRange.bound([dumpId, -Infinity], [dumpId, Infinity]);
  await tx.objectStore('dumpBlocks').delete(range);
  await tx.objectStore('dumps').delete(dumpId);
  await tx.done;
}
