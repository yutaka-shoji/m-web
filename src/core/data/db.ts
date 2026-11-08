/**
 * IndexedDB schema (database "m-web"). Works in the page, in workers and — through
 * fake-indexeddb — in tests.
 *
 * sessions   one PC recording (several devices)
 * chunks     samples, column-oriented typed arrays, appended every ~2 s per device
 * events     connection/recording events of a session (for the export notes)
 * dumps      flash downloads (P7); dumpBlocks hold the raw 22-byte records
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ComfortConditions } from '../comfort/comfort';
import type { Settings, Transports } from '../protocol/types';

export const DB_NAME = 'm-web';
export const DB_VERSION = 1;

export type SessionStatus = 'recording' | 'stopped' | 'interrupted';

export interface SessionDevice {
  hardwareId: string;
  name: string;
  firmware: string | null;
  colorIndex: number;
  settings: Settings | null;
  transports: Transports;
  joinedAt: number;
  leftAt: number | null;
  samples: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  startedAt: number;
  endedAt: number | null;
  status: SessionStatus;
  /** IANA time zone of the PC when recording started. */
  tz: string;
  appVersion: string;
  conditions: ComfortConditions;
  devices: SessionDevice[];
  samples: number;
}

export interface ChunkRecord {
  sessionId: string;
  hardwareId: string;
  seq: number;
  t0: number;
  t1: number;
  n: number;
  ts: Float64Array;
  t: Float32Array;
  h: Float32Array;
  g: Float32Array;
  v: Float32Array;
  vv: Float32Array;
  l: Float32Array;
  c: Float32Array;
  /** null markers and wu/dc bits, see series.ts encodeFlags */
  flags: Uint16Array;
}

export interface EventRecord {
  id?: number;
  sessionId: string;
  hardwareId: string | null;
  at: number;
  kind: 'start' | 'stop' | 'join' | 'leave' | 'disconnect' | 'reconnect' | 'restart' | 'time_sync' | 'error';
  detail?: string;
}

export interface DumpRecordMeta {
  id: string;
  hardwareId: string;
  name: string;
  firmware: string | null;
  startedAt: number;
  finishedAt: number | null;
  total: number;
  recordSize: number;
  blockRecords: number;
  blocksDone: number;
  status: 'running' | 'paused' | 'done' | 'failed';
  error: string | null;
}

export interface DumpBlockRecord {
  dumpId: string;
  index: number;
  from: number;
  count: number;
  bytes: Uint8Array;
}

export interface MWebDB extends DBSchema {
  sessions: { key: string; value: SessionRecord; indexes: { byStart: number } };
  chunks: { key: [string, string, number]; value: ChunkRecord; indexes: { bySession: string } };
  events: { key: number; value: EventRecord; indexes: { bySession: string } };
  dumps: { key: string; value: DumpRecordMeta; indexes: { byDevice: string } };
  dumpBlocks: { key: [string, number]; value: DumpBlockRecord };
}

export type Db = IDBPDatabase<MWebDB>;

export function openMWebDB(name = DB_NAME): Promise<Db> {
  return openDB<MWebDB>(name, DB_VERSION, {
    upgrade(db) {
      const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
      sessions.createIndex('byStart', 'startedAt');
      const chunks = db.createObjectStore('chunks', { keyPath: ['sessionId', 'hardwareId', 'seq'] });
      chunks.createIndex('bySession', 'sessionId');
      const events = db.createObjectStore('events', { keyPath: 'id', autoIncrement: true });
      events.createIndex('bySession', 'sessionId');
      const dumps = db.createObjectStore('dumps', { keyPath: 'id' });
      dumps.createIndex('byDevice', 'hardwareId');
      db.createObjectStore('dumpBlocks', { keyPath: ['dumpId', 'index'] });
    },
  });
}

/** Sortable unique id (time-ordered). */
export function newId(now = Date.now()): string {
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return now.toString(36).padStart(9, '0') + Array.from(rand, (b) => b.toString(36).padStart(2, '0')).join('');
}

/** All chunks of one device in a session, in sequence order. */
export async function* iterateChunks(db: Db, sessionId: string, hardwareId: string): AsyncGenerator<ChunkRecord> {
  const range = IDBKeyRange.bound([sessionId, hardwareId, -Infinity], [sessionId, hardwareId, Infinity]);
  let cursor = await db.transaction('chunks').store.openCursor(range);
  while (cursor) {
    yield cursor.value;
    cursor = await cursor.continue();
  }
}

/** Delete a session and its chunks/events in batches (resumable). */
export async function deleteSession(db: Db, sessionId: string): Promise<void> {
  for (;;) {
    const tx = db.transaction('chunks', 'readwrite');
    const keys = await tx.store.index('bySession').getAllKeys(sessionId, 500);
    for (const k of keys) await tx.store.delete(k);
    await tx.done;
    if (keys.length < 500) break;
  }
  const tx = db.transaction(['events', 'sessions'], 'readwrite');
  const evKeys = await tx.objectStore('events').index('bySession').getAllKeys(sessionId);
  for (const k of evKeys) await tx.objectStore('events').delete(k);
  await tx.objectStore('sessions').delete(sessionId);
  await tx.done;
}
