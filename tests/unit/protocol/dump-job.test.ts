import { afterEach, describe, expect, it } from 'vitest';
import { MLoggerClient } from '../../../src/core/protocol/client';
import { runDump } from '../../../src/core/protocol/dump-job';
import { AbortedError, DumpError, DumpStallError, ProtocolError } from '../../../src/core/protocol/errors';
import { concatBytes } from '../../../src/core/util/bytes';
import { FakeFirmwareLink, makeRecords, type FakeFirmwareOptions } from '../../helpers/fake-firmware';

const clients: MLoggerClient[] = [];
function setup(opts: FakeFirmwareOptions) {
  const fw = new FakeFirmwareLink(opts);
  const client = new MLoggerClient(fw, { gapMs: 1, timeoutCooldownMs: 5 });
  clients.push(client);
  return { fw, client };
}
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

const FAST = { stallMs: 60, quietMs: 30, quietMaxMs: 500 };

async function collect(client: MLoggerClient, extra: Partial<Parameters<typeof runDump>[1]> = {}) {
  const blocks: Uint8Array[] = [];
  const res = await runDump(client, {
    blockRecords: 1000,
    ...FAST,
    ...extra,
    onBlock: (_b, _from, _n, bytes) => {
      blocks.push(bytes.slice());
    },
  });
  return { res, data: concatBytes(...blocks) };
}

describe('dump job (block pull)', () => {
  it('downloads every record exactly, block by block', async () => {
    const records = makeRecords(2500);
    const { client } = setup({ records });
    const { res, data } = await collect(client);
    expect(res).toMatchObject({ total: 2500, blocks: 3, retries: 0 });
    expect(data).toEqual(records);
  });

  it('re-requests a stalled block and ignores late bytes from the failed attempt', async () => {
    const records = makeRecords(2100);
    // On-time bytes end at ~25 ms, the stall fires at ~85 ms, the withheld 17 kB arrive at
    // 110 ms (not in binary mode any more) — the retry must wait for quiet and reset the decoder.
    const { client } = setup({
      records,
      dumpFaults: [{ from: 1000, attempt: 1, stallAfterBytes: 5000, lateMs: 110 }],
    });
    const { res, data } = await collect(client, { quietMs: 120 });
    expect(res.retries).toBe(1);
    expect(data).toEqual(records);
  });

  it('gives up after maxAttempts', async () => {
    const records = makeRecords(1200);
    const faults = [1, 2].map((attempt) => ({ from: 0, attempt, stallAfterBytes: 100 }));
    const { client } = setup({ records, dumpFaults: faults });
    await expect(collect(client, { maxAttempts: 2 })).rejects.toBeInstanceOf(DumpStallError);
  });

  it('resumes from a block and refuses if the record count changed', async () => {
    const records = makeRecords(3000);
    const { client } = setup({ records });
    const { data } = await collect(client, { startBlock: 2, expectTotal: 3000 });
    expect(data).toEqual(records.subarray(2000 * 22));
    await expect(collect(client, { startBlock: 1, expectTotal: 2999 })).rejects.toBeInstanceOf(DumpError);
  });

  it('is refused while logging (busy)', async () => {
    const { fw, client } = setup({ records: makeRecords(10) });
    fw.logging = true;
    const err = await collect(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('busy');
  });

  it('keeps the device exclusive until the stream is quiet after a cancel', async () => {
    const records = makeRecords(1000);
    const { client } = setup({ records, dumpFaults: [{ from: 0, attempt: 1, stallAfterBytes: 3000, lateMs: 50 }] });
    const ac = new AbortController();
    const p = collect(client, { signal: ac.signal, stallMs: 1000 });
    setTimeout(() => ac.abort(), 20);
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    // The next ordinary command must parse fine (late binary was drained before release).
    expect((await client.call('hello', undefined)).device).toBe('M-Logger');
  });

  it('hands the device back only after the tail of a failed last attempt has arrived', async () => {
    const records = makeRecords(1000);
    // The only attempt stalls at ~85 ms; its withheld bytes arrive at ~110 ms.
    const { fw, client } = setup({ records, dumpFaults: [{ from: 0, attempt: 1, stallAfterBytes: 5000, lateMs: 110 }] });
    const err = await collect(client, { maxAttempts: 1, quietMs: 120 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DumpStallError);
    expect(fw.lateEmitted).toBe(1); // drained before the lease was released
    expect((await client.call('hello', undefined, { timeoutMs: 300, retry: false })).device).toBe('M-Logger');
  });

  it('still reads replies when late binary bytes come after the device was handed back', async () => {
    const records = makeRecords(1000);
    // A stall implies a silent link, so the device is released at once; the tail comes later
    // and its last bytes stick to the front of the next reply.
    const { fw, client } = setup({ records, dumpFaults: [{ from: 0, attempt: 1, stallAfterBytes: 5000, lateMs: 150 }] });
    await expect(collect(client, { maxAttempts: 1 })).rejects.toBeInstanceOf(DumpStallError);
    while (fw.lateEmitted === 0) await new Promise((r) => setTimeout(r, 10));
    expect((await client.call('hello', undefined, { timeoutMs: 300, retry: false })).device).toBe('M-Logger');
  });

  it('closes the link instead of retrying while the logger keeps sending', async () => {
    const records = makeRecords(1000);
    // Attempt 1 stalls at ~70 ms; from 100 ms its tail trickles in for ~1.4 s, past quietMaxMs.
    const { fw, client } = setup({
      records,
      dumpFaults: [{ from: 0, attempt: 1, stallAfterBytes: 1000, lateMs: 100, lateChunkMs: 15 }],
    });
    const err = await collect(client, { quietMs: 120, quietMaxMs: 300 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DumpError);
    expect(fw.closed).toBe(true);
    expect(client.closed).toBe(true);
    expect(fw.accepted.filter((l) => l.includes('"dump"'))).toHaveLength(1); // no retry was sent
  });

  it('reports progress with an ETA', async () => {
    const { client } = setup({ records: makeRecords(1500) });
    const seen: number[] = [];
    await collect(client, { onProgress: (p) => seen.push(p.doneRecords) });
    expect(seen.at(-1)).toBe(1500);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true);
  });
});
