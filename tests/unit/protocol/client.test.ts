import { afterEach, describe, expect, it } from 'vitest';
import { MLoggerClient } from '../../../src/core/protocol/client';
import { ClientClosedError, CommandTimeoutError, ProtocolError, AbortedError } from '../../../src/core/protocol/errors';
import type { SmpEvent, TimeSyncRequest } from '../../../src/core/protocol/types';
import { FakeFirmwareLink } from '../../helpers/fake-firmware';

const clients: MLoggerClient[] = [];
function setup(opts: ConstructorParameters<typeof FakeFirmwareLink>[0] = {}) {
  const fw = new FakeFirmwareLink(opts);
  const client = new MLoggerClient(fw, { gapMs: 2, timeoutCooldownMs: 5 });
  clients.push(client);
  return { fw, client };
}
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

describe('MLoggerClient', () => {
  it('answers typed commands', async () => {
    const { client } = setup();
    const hello = await client.call('hello', undefined);
    expect(hello.device).toBe('M-Logger');
    expect((await client.call('get_settings', undefined)).general.interval).toBe(5);
    const s = await client.call('set_settings', { velocity: { enabled: true, interval: 30 } });
    expect(s.velocity).toEqual({ enabled: true, interval: 30 });
  });

  it('never pipelines: concurrent calls reach the firmware one at a time (nothing dropped)', async () => {
    const { fw, client } = setup({ procMs: 3 });
    const results = await Promise.all([
      client.call('hello', undefined),
      client.call('get_battery', undefined),
      client.call('get_settings', undefined),
      client.call('get_correction', undefined),
      client.call('get_probe_info', undefined),
    ]);
    expect(results).toHaveLength(5);
    expect(fw.dropped).toBe(0);
    expect(fw.accepted.map((l) => JSON.parse(l).command)).toEqual([
      'hello',
      'get_battery',
      'get_settings',
      'get_correction',
      'get_probe_info',
    ]);
  });

  it('serves urgent before normal before background', async () => {
    const { fw, client } = setup({ procMs: 3 });
    const first = client.call('hello', undefined); // goes out immediately
    const order: string[] = [];
    const p = [
      client.call('get_battery', undefined, { priority: 'background' }).then(() => order.push('bg')),
      client.call('get_settings', undefined).then(() => order.push('normal')),
      client.call('set_time', { ts: 1_800_000_000 }, { priority: 'urgent' }).then(() => order.push('urgent')),
    ];
    await first;
    await Promise.all(p);
    expect(order).toEqual(['urgent', 'normal', 'bg']);
    expect(fw.accepted.map((l) => JSON.parse(l).command)).toEqual(['hello', 'set_time', 'get_settings', 'get_battery']);
  });

  it('maps error replies to ProtocolError', async () => {
    const { client } = setup();
    const err = await client
      .call('start_logging', { transports: { zigbee: false, ble: true, flash: false, usb: false }, mode: 'once' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect((err as ProtocolError).code).toBe('rtc_unset');
  });

  it('retries an idempotent command once after a lost reply, but not start_logging', async () => {
    const { fw, client } = setup({ dropNextLines: 1 });
    const hello = await client.call('hello', undefined, { timeoutMs: 30 });
    expect(hello.name).toBe('MLogger_0001');
    expect(client.stats.retries).toBe(1);

    await client.call('set_time', { ts: 1_800_000_000 });
    fw['opts'].dropNextLines = 1;
    const err = await client
      .call('start_logging', { transports: { zigbee: false, ble: true, flash: false, usb: false }, mode: 'once' }, { timeoutMs: 30 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandTimeoutError);
  });

  it('ignores a late reply that arrives after the timeout', async () => {
    const { client } = setup({ procMs: 40 });
    const err = await client.call('get_battery', undefined, { timeoutMs: 10, retry: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommandTimeoutError);
    await new Promise((r) => setTimeout(r, 60)); // late reply lands now
    expect((await client.call('hello', undefined)).device).toBe('M-Logger');
  });

  it('dispatches smp and time_sync_request events with sanitised data', async () => {
    const { fw, client } = setup();
    const smp: SmpEvent[] = [];
    const sync: TimeSyncRequest[] = [];
    client.on('smp', (e) => smp.push(e));
    client.on('time_sync_request', (e) => sync.push(e));
    fw.emitEvent('smp', { t: 23.45, h: null, g: 24.1, wu: ['g', 'x'], junk: 1 }, 1_800_000_000);
    fw.emitEvent('time_sync_request', { window_s: 30, name: 'MLogger_0001' });
    await new Promise((r) => setTimeout(r, 20));
    expect(smp[0]!.ts).toBe(1_800_000_000);
    expect(smp[0]!.data).toEqual({ t: 23.45, h: null, g: 24.1, wu: ['g'] });
    expect(sync[0]!.window_s).toBe(30);
  });

  it('rejects everything pending when the link closes', async () => {
    const { fw, client } = setup({ procMs: 50 });
    const a = client.call('hello', undefined);
    const b = client.call('get_battery', undefined);
    fw.disconnect();
    await expect(a).rejects.toBeInstanceOf(ClientClosedError);
    await expect(b).rejects.toBeInstanceOf(ClientClosedError);
    await expect(client.call('hello', undefined)).rejects.toBeInstanceOf(ClientClosedError);
  });

  it('aborts a queued call without disturbing the queue', async () => {
    const { client } = setup({ procMs: 10 });
    const ac = new AbortController();
    const first = client.call('hello', undefined);
    const second = client.call('get_battery', undefined, { signal: ac.signal });
    const third = client.call('get_settings', undefined);
    ac.abort();
    await expect(second).rejects.toBeInstanceOf(AbortedError);
    await expect(first).resolves.toBeTruthy();
    await expect(third).resolves.toBeTruthy();
  });
});
