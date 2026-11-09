/**
 * Block-pull download of the flash log (port of MLLib JsonRpcV4Protocol.DumpAsync):
 * `get_count`, then `dump{from,limit}` per block of 1000 records with a sliding stall
 * timeout; a stalled block is re-requested (max 4 attempts) after the link has been quiet,
 * so late bytes of the previous attempt cannot mix into the next response. Completion is
 * judged by byte count, never by `dump_end`. Blocks are handed to `onBlock` as they finish,
 * which makes the job resumable from any block boundary.
 *
 * Whenever a block request ends early (stall, cancel, timeout, bad header) the firmware may
 * still be streaming the rest of the block. The device is handed back only once it has gone
 * quiet; if it keeps sending, the link is closed instead (the controller reconnects), since
 * those bytes would otherwise be read as the replies to later commands.
 */
import type { ExclusiveLease, MLoggerClient } from './client';
import { AbortedError, DumpError, DumpStallError, ProtocolError } from './errors';
import { RECORD_SIZE } from './record';
import type { CountResult } from './types';

export interface DumpProgress {
  totalRecords: number;
  doneRecords: number;
  /** Bytes/second, smoothed. */
  rate: number;
  /** Seconds remaining (Infinity until a rate is known). */
  etaSec: number;
  block: number;
  attempt: number;
}

export interface DumpJobOptions {
  blockRecords?: number;
  maxAttempts?: number;
  stallMs?: number;
  /** Silence (ms) that shows the device has stopped sending. */
  quietMs?: number;
  /** How long (ms) to wait for that silence before giving up on the link. */
  quietMaxMs?: number;
  /** Resume: first block to fetch. The total must still equal `expectTotal`. */
  startBlock?: number;
  expectTotal?: number;
  onCount?: (info: CountResult) => void | Promise<void>;
  onBlock: (block: number, from: number, count: number, bytes: Uint8Array) => void | Promise<void>;
  onProgress?: (p: DumpProgress) => void;
  signal?: AbortSignal;
  now?: () => number;
}

export interface DumpResult {
  total: number;
  blocks: number;
  bytes: number;
  retries: number;
}

/** Typical BLE dump throughput (B/s), used for the pre-download estimate. */
export const NOMINAL_DUMP_RATE = 2200;

export function estimateDumpSeconds(records: number): number {
  return (records * RECORD_SIZE) / NOMINAL_DUMP_RATE;
}

export async function runDump(client: MLoggerClient, opts: DumpJobOptions): Promise<DumpResult> {
  const blockRecords = opts.blockRecords ?? 1000;
  const maxAttempts = opts.maxAttempts ?? 4;
  const stallMs = opts.stallMs ?? 8000;
  const quietMs = opts.quietMs ?? 700;
  // The rest of a 22 kB block takes up to ~18 s at the slowest firmware rate (1.2 kB/s).
  const quietMaxMs = opts.quietMaxMs ?? 20_000;
  const now = opts.now ?? (() => Date.now());
  const signal = opts.signal;

  const lease: ExclusiveLease = await client.acquireExclusive(signal);
  /** A block request ended before all of its bytes were read; the rest may still arrive. */
  let tailPending = false;
  /**
   * Wait for the device to stop sending, then drop the partial line those bytes left behind.
   * A link that keeps sending is closed instead. Returns whether the link is usable.
   */
  const settle = async (): Promise<boolean> => {
    const quiet = await lease.waitRxQuiet(quietMs, quietMaxMs);
    tailPending = false;
    if (quiet) lease.resetDecoder();
    else lease.closeLink('the logger kept sending after an interrupted download block');
    return quiet;
  };
  try {
    const info = await lease.call('get_count', undefined, signal ? { signal } : {});
    if (info.record_size !== RECORD_SIZE) throw new DumpError(`unsupported record size ${info.record_size}`);
    if (opts.expectTotal !== undefined && info.count !== opts.expectTotal) {
      throw new DumpError(`record count changed (${opts.expectTotal} → ${info.count}); restart the download`);
    }
    await opts.onCount?.(info);

    const total = info.count;
    const nBlocks = Math.ceil(total / blockRecords);
    let done = Math.min(total, (opts.startBlock ?? 0) * blockRecords);
    let bytes = 0;
    let retries = 0;
    let rate = 0;
    let lastT = now();
    let lastBytes = 0;
    let receivedTotal = 0;
    const report = (block: number, attempt: number) => {
      const t = now();
      if (t - lastT >= 500) {
        const inst = ((receivedTotal - lastBytes) * 1000) / (t - lastT);
        rate = rate === 0 ? inst : 0.8 * rate + 0.2 * inst;
        lastT = t;
        lastBytes = receivedTotal;
      }
      const remaining = (total - done) * RECORD_SIZE;
      opts.onProgress?.({
        totalRecords: total,
        doneRecords: done,
        rate,
        etaSec: rate > 0 ? remaining / rate : Infinity,
        block,
        attempt,
      });
    };

    for (let b = opts.startBlock ?? 0; b < nBlocks; b++) {
      const from = b * blockRecords;
      const limit = Math.min(blockRecords, total - from);
      const buf = new Uint8Array(limit * RECORD_SIZE);
      for (let attempt = 1; ; attempt++) {
        if (signal?.aborted) throw new AbortedError();
        if (tailPending && !(await settle())) {
          throw new DumpError('the logger kept sending after a stalled block; reconnecting');
        }
        let inBlock = 0;
        try {
          await lease.dumpBlock(from, limit, buf, {
            stallMs,
            ...(signal ? { signal } : {}),
            onBytes: (n) => {
              inBlock += n;
              receivedTotal += n;
              done = from + Math.floor(inBlock / RECORD_SIZE);
              report(b, attempt);
            },
          });
          break;
        } catch (err) {
          // An error reply ends the request; any other failure may leave the block streaming.
          if (!(err instanceof ProtocolError)) tailPending = true;
          receivedTotal -= inBlock;
          done = from;
          if (!(err instanceof DumpStallError) || attempt >= maxAttempts) throw err;
          retries += 1;
        }
      }
      done = from + limit;
      bytes += buf.length;
      await opts.onBlock(b, from, limit, buf);
      report(b, 1);
    }
    return { total, blocks: nBlocks, bytes, retries };
  } finally {
    // Cancelled or failed for good: the rest of the block must not reach the next command.
    if (tailPending) await settle();
    lease.release();
  }
}
