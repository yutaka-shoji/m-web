import { openMWebDB, type Db } from '../core/data/db';

let dbPromise: Promise<Db> | null = null;

/** The page's single IndexedDB connection. */
export function getDb(): Promise<Db> {
  dbPromise ??= openMWebDB();
  return dbPromise;
}
