/**
 * Dev-only hardware smoke harness (served at /dev/hw-smoke.html by the Vite dev server,
 * driven by scripts/hw-smoke.mjs through Puppeteer). Runs the production BLE link code in
 * Chrome against real M-Loggers and sends READ-ONLY commands only.
 */
import { MLOGGER_SCAN_FILTERS, XBEE_SERVICE_UUID } from '../core/ble/constants';
import { WebBluetoothTransport } from '../core/ble/web-bluetooth';
import { openXBeeLink, type PayloadLink } from '../core/ble/xbee-link';
import { MLoggerClient } from '../core/protocol/client';
import { runDump, type DumpProgress } from '../core/protocol/dump-job';
import { decodeRecords } from '../core/protocol/record';
import type { SmpEvent } from '../core/protocol/types';
import { utf8 } from '../core/util/bytes';

const READ_ONLY = ['hello', 'get_battery', 'get_settings', 'get_correction', 'get_probe_info', 'get_count'] as const;
const GAP_MS = 300;

interface Session {
  device: BluetoothDevice;
  link: PayloadLink;
  connectMs: number;
  events: unknown[];
  request(command: string, params?: unknown, timeoutMs?: number): Promise<{ rtt: number; msg: Record<string, unknown> }>;
  close(): void;
}

const sessions: Session[] = [];
const results: Record<string, unknown>[] = [];
const logEl = document.getElementById('log')!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(...parts: unknown[]): void {
  const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
  console.log(line);
  logEl.textContent += line + '\n';
}

async function connect(device: BluetoothDevice, writeChunk: number): Promise<Session> {
  const t0 = performance.now();
  const transport = new WebBluetoothTransport(device);
  await transport.open();
  const link = await openXBeeLink(transport, { writeChunk });
  const connectMs = performance.now() - t0;
  const dec = new TextDecoder();
  let buf = '';
  let nextId = 1;
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  const events: unknown[] = [];
  link.onPayload((p) => {
    buf += dec.decode(p, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const w = typeof msg.id === 'number' ? waiters.get(msg.id) : undefined;
        if (w) w(msg);
        else events.push(msg);
      } catch {
        events.push({ unparsed: line });
      }
    }
  });
  link.onClose((e) => log(`[${device.name}] link closed: ${e.kind} ${e.message}`));
  return {
    device,
    link,
    connectMs,
    events,
    async request(command, params, timeoutMs = 5000) {
      const id = nextId++;
      const line = JSON.stringify(params === undefined ? { v: 1, id, command } : { v: 1, id, command, params }) + '\n';
      const t = performance.now();
      const msg = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          reject(new Error(`${command}: timeout after ${timeoutMs} ms`));
        }, timeoutMs);
        waiters.set(id, (m) => {
          clearTimeout(timer);
          waiters.delete(id);
          resolve(m);
        });
        link.sendLine(utf8(line)).catch((e: unknown) => {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        });
      });
      return { rtt: performance.now() - t, msg };
    },
    close() {
      link.close();
    },
  };
}

async function addAndTest(): Promise<void> {
  const r: Record<string, unknown> = {};
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: MLOGGER_SCAN_FILTERS,
      optionalServices: [XBEE_SERVICE_UUID],
    });
    r.name = device.name;
    const s = await connect(device, 20);
    r.connectMs = Math.round(s.connectMs);
    r.unlockMs = s.link.stats.unlockMs;
    r.unlockAttempts = s.link.stats.unlockAttempts;
    for (const cmd of READ_ONLY) {
      const { rtt, msg } = await s.request(cmd, undefined, cmd === 'get_count' ? 10_000 : 5000);
      r[cmd] = { rttMs: Math.round(rtt), ...(msg.result ? { result: msg.result } : { error: msg.error }) };
      await sleep(GAP_MS);
    }
    r.events = s.events.slice(0, 5);
    r.stats = { ...s.link.stats };
    sessions.push(s);
  } catch (e) {
    r.error = String(e);
  }
  log(r);
  results.push(r);
}

async function concurrentHello(): Promise<Record<string, unknown>> {
  const t = performance.now();
  const answers = await Promise.allSettled(sessions.map((s) => s.request('hello')));
  const out = {
    devices: sessions.length,
    totalMs: Math.round(performance.now() - t),
    answers: answers.map((a, i) =>
      a.status === 'fulfilled'
        ? { name: sessions[i]!.device.name, rttMs: Math.round(a.value.rtt), ok: !!a.value.msg.result }
        : { name: sessions[i]!.device.name, error: String(a.reason) },
    ),
  };
  log('concurrent', out);
  return out;
}

/** Reconnect one device with several write-chunk sizes and time get_settings. */
async function chunkTest(index = 0, chunks = [20, 182, 240]): Promise<Record<string, unknown>> {
  const s0 = sessions[index];
  if (!s0) return { error: 'no session' };
  const device = s0.device;
  s0.close();
  const out: Record<string, unknown> = { name: device.name };
  for (const chunk of chunks) {
    await sleep(1500);
    let s: Session | null = null;
    try {
      s = await connect(device, chunk);
      const rtts: number[] = [];
      for (let i = 0; i < 5; i++) {
        rtts.push(Math.round((await s.request('get_settings')).rtt));
        await sleep(GAP_MS);
      }
      out[`chunk${chunk}`] = { ok: true, unlockMs: s.link.stats.unlockMs, getSettingsRttMs: rtts };
    } catch (e) {
      out[`chunk${chunk}`] = { ok: false, error: String(e) };
    } finally {
      s?.close();
    }
  }
  await sleep(1500);
  sessions[index] = await connect(device, 20);
  log('chunk test', out);
  return out;
}

/**
 * Protocol-client check on one already-authorised device: set_time, BLE-only live logging
 * (flash untouched) for `seconds`, stop, then download the whole flash log (read-only).
 */
async function liveAndDump(index = 0, seconds = 30): Promise<Record<string, unknown>> {
  const s0 = sessions[index];
  if (!s0) return { error: 'no session' };
  const device = s0.device;
  s0.close();
  await sleep(1200);
  const out: Record<string, unknown> = { name: device.name };
  const transport = new WebBluetoothTransport(device);
  await transport.open();
  const link = await openXBeeLink(transport);
  const client = new MLoggerClient(link);
  const smp: SmpEvent[] = [];
  const other: string[] = [];
  client.on('smp', (e) => smp.push(e));
  client.on('ready', (e) => other.push(`ready ${JSON.stringify(e)}`));
  client.on('unparsed', (l) => other.push(`unparsed ${l.slice(0, 80)}`));
  try {
    const hello = await client.call('hello', undefined);
    out.loggingBefore = hello.logging;
    if (hello.logging) throw new Error('device is already logging; not touching it');
    const now = Math.floor(Date.now() / 1000);
    await client.call('set_time', { ts: now });
    const t0 = performance.now();
    await client.call('start_logging', {
      transports: { zigbee: false, ble: true, flash: false, usb: false },
      mode: 'once',
    });
    out.startLatencyMs = Math.round(performance.now() - t0);
    await sleep(seconds * 1000);
    await client.call('stop_logging', undefined, { priority: 'urgent' });
    out.smpCount = smp.length;
    out.smpFirst = smp[0];
    out.smpLast = smp.at(-1);
    out.smpClockSkewSec = smp.map((e) => Math.round(e.receivedAt / 1000 - e.ts));
    out.otherLines = other.slice(0, 10);

    await sleep(1000);
    const blocks: Uint8Array[] = [];
    const tDump = performance.now();
    let lastProgress: DumpProgress | null = null;
    const res = await runDump(client, {
      onBlock: (_b, _from, _n, bytes) => {
        blocks.push(bytes.slice());
      },
      onProgress: (p) => (lastProgress = p),
    });
    const secs = (performance.now() - tDump) / 1000;
    const all = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
    let off = 0;
    for (const b of blocks) {
      all.set(b, off);
      off += b.length;
    }
    const recs = decodeRecords(all);
    out.dump = {
      ...res,
      seconds: Math.round(secs * 10) / 10,
      bytesPerSec: Math.round(res.bytes / secs),
      lastProgress,
      gens: [...new Set(recs.map((r) => r.gen))],
      first: recs[0],
      last: recs.at(-1),
      monotonic: recs.every((r, i) => i === 0 || r.ts >= recs[i - 1]!.ts),
    };
    out.clientStats = { ...client.stats };
    out.linkStats = { ...link.stats };
  } catch (e) {
    out.error = String(e);
  } finally {
    link.close();
  }
  log('live+dump', out);
  return out;
}

function closeAll(): void {
  for (const s of sessions) s.close();
  sessions.length = 0;
}

document.getElementById('add')!.addEventListener('click', () => void addAndTest());
document.getElementById('scansvc')?.addEventListener('click', () => {
  navigator.bluetooth
    .requestDevice({ filters: [{ services: [XBEE_SERVICE_UUID] }] })
    .then((d) => log(`picked ${d.name ?? d.id}`))
    .catch((e: unknown) => log(`scan-svc ended: ${String(e)}`));
});
document.getElementById('scanall')?.addEventListener('click', () => {
  navigator.bluetooth
    .requestDevice({ acceptAllDevices: true, optionalServices: [XBEE_SERVICE_UUID] })
    .then((d) => log(`picked ${d.name ?? d.id}`))
    .catch((e: unknown) => log(`scan-all ended: ${String(e)}`));
});
document.getElementById('concurrent')!.addEventListener('click', () => void concurrentHello());
document.getElementById('close')!.addEventListener('click', closeAll);

Object.assign(window, { __mweb: { results, sessions, concurrentHello, chunkTest, liveAndDump, closeAll } });
log(`ready; Web Bluetooth ${'bluetooth' in navigator ? 'available' : 'NOT available'}`);
