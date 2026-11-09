/**
 * Simulated M-Logger MCU behind a PayloadLink (no BLE/crypto), for protocol-client tests.
 * Mirrors firmware behaviour that matters to the client:
 *  - one pending line per source: bytes arriving while a line awaits processing are dropped
 *  - replies are split into ≤220-byte relay payloads
 *  - dump: JSON header, raw 22-byte records in 220-byte chunks, then a dump_end event
 */
import type { LinkError, LinkStats, PayloadLink } from '../../src/core/ble/xbee-link';
import { LinkError as LinkErrorClass } from '../../src/core/ble/xbee-link';
import { utf8 } from '../../src/core/util/bytes';
import { Listeners, type Unsubscribe } from '../../src/core/util/emitter';
import type { Correction, Settings, SmpData } from '../../src/core/protocol/types';

export interface DumpFault {
  /** Record index the faulty block starts at. */
  from: number;
  /** Which attempt (1-based) of that block misbehaves. */
  attempt: number;
  /** Stop after sending this many binary bytes. */
  stallAfterBytes: number;
  /** Deliver the withheld bytes this many ms later (late data from a stalled attempt). */
  lateMs?: number;
  /** Deliver them in 220-byte payloads this many ms apart instead of all at once. */
  lateChunkMs?: number;
}

export interface FakeFirmwareOptions {
  records?: Uint8Array;
  /** Processing time of one command line. */
  procMs?: number;
  dumpFaults?: DumpFault[];
  /** Answer the next N lines with nothing (simulate lost commands). */
  dropNextLines?: number;
  smpIntervalMs?: number;
}

export class FakeFirmwareLink implements PayloadLink {
  readonly transportId = 'fake-fw';
  readonly stats: LinkStats = {
    writeChunk: 20,
    txFrames: 0,
    txBytes: 0,
    rxBytes: 0,
    rxFrames: 0,
    badChecksums: 0,
    discardedBytes: 0,
    lastRxAt: 0,
    unlockMs: 0,
    unlockAttempts: 1,
  };
  /** Every complete line the firmware accepted (for assertions). */
  readonly accepted: string[] = [];
  /** Lines (or fragments) dropped because a previous line was still pending. */
  dropped = 0;
  /** Late payloads of faulty dump attempts delivered so far. */
  lateEmitted = 0;
  name = 'MLogger_0001';
  logging = false;
  rtcSet = false;
  transports = { zigbee: false, ble: false, flash: false, usb: false };
  settings: Settings = {
    general: { enabled: true, interval: 5 },
    velocity: { enabled: false, interval: 60 },
    illuminance: { enabled: false, interval: 60 },
    start_ts: 0,
  };
  correction: Correction = {
    t_dry: { a: 1, b: 0 },
    humidity: { a: 1, b: 0 },
    t_glb: { a: 1, b: 0 },
    illuminance: { a: 1, b: 0 },
    velocity: { a: 1, b: 0 },
  };
  records: Uint8Array;

  private closed_ = false;
  private readonly payloadL = new Listeners<[Uint8Array]>();
  private readonly closeL = new Listeners<[LinkError]>();
  private lineBuf = '';
  private pending = false;
  private readonly dumpAttempts = new Map<number, number>();
  private smpTimer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: FakeFirmwareOptions;

  constructor(opts: FakeFirmwareOptions = {}) {
    this.opts = opts;
    this.records = opts.records ?? new Uint8Array(0);
  }

  get closed() {
    return this.closed_;
  }

  onPayload(cb: (b: Uint8Array) => void): Unsubscribe {
    return this.payloadL.add(cb);
  }

  onClose(cb: (e: LinkError) => void): Unsubscribe {
    return this.closeL.add(cb);
  }

  close(reason = 'closed'): void {
    if (this.closed_) return;
    this.closed_ = true;
    if (this.smpTimer) clearInterval(this.smpTimer);
    this.closeL.emit(new LinkErrorClass(reason, 'closed'));
  }

  disconnect(): void {
    if (this.closed_) return;
    this.closed_ = true;
    if (this.smpTimer) clearInterval(this.smpTimer);
    this.closeL.emit(new LinkErrorClass('device disconnected', 'disconnected'));
  }

  async sendLine(line: Uint8Array): Promise<void> {
    if (this.closed_) throw new LinkErrorClass('closed', 'closed');
    const text = new TextDecoder().decode(line);
    for (const ch of text) {
      if (this.pending) {
        this.dropped += 1; // firmware: `if (b->ready) return;`
        continue;
      }
      if (ch === '\n' || ch === '\r') {
        if (this.lineBuf.length > 0) {
          const l = this.lineBuf;
          this.lineBuf = '';
          this.pending = true;
          setTimeout(() => this.process(l), this.opts.procMs ?? 2);
        }
      } else this.lineBuf += ch;
    }
  }

  /** Emit an event line from the "device". */
  emitEvent(event: string, data: unknown, ts = Math.floor(Date.now() / 1000)): void {
    this.sendText(JSON.stringify({ v: 1, event, ts, data }) + '\n');
  }

  private process(line: string): void {
    this.pending = false;
    if (this.closed_) return;
    if ((this.opts.dropNextLines ?? 0) > 0) {
      this.opts.dropNextLines! -= 1;
      return;
    }
    let msg: { id?: unknown; command?: unknown; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(line);
    } catch {
      this.reply(0, null, { code: 'invalid_params', message: 'json' });
      return;
    }
    this.accepted.push(line);
    const id = typeof msg.id === 'number' ? msg.id : 0;
    const p = msg.params ?? {};
    switch (msg.command) {
      case 'hello':
        return this.reply(id, {
          device: 'M-Logger',
          firmware_version: '4.0.1',
          protocol_version: 1,
          hardware_id: '3DF27622',
          name: this.name,
          logging: this.logging,
        });
      case 'get_battery':
        return this.reply(id, { voltage_mv: 2702, low_battery: false });
      case 'get_settings':
        return this.reply(id, this.settings);
      case 'set_settings':
        for (const k of ['general', 'velocity', 'illuminance'] as const) {
          if (p[k]) Object.assign(this.settings[k], p[k]);
        }
        if (typeof p.start_ts === 'number') this.settings.start_ts = p.start_ts;
        return this.reply(id, this.settings);
      case 'get_correction':
        return this.reply(id, this.correction);
      case 'set_time':
        this.rtcSet = true;
        return this.reply(id, { ts: p.ts });
      case 'set_name':
        this.name = String(p.name);
        return this.reply(id, { name: this.name });
      case 'get_probe_info':
        return this.reply(id, { th_probe: { connected: true }, velocity_probe: { connected: false } });
      case 'start_logging': {
        if (!this.rtcSet) return this.reply(id, null, { code: 'rtc_unset', message: 'set time first' });
        this.transports = { ...this.transports, ...(p.transports as object) };
        this.logging = true;
        this.reply(id, {});
        if (this.transports.ble && this.opts.smpIntervalMs) {
          if (this.smpTimer) clearInterval(this.smpTimer);
          this.smpTimer = setInterval(() => this.emitEvent('smp', sampleData()), this.opts.smpIntervalMs);
        }
        return;
      }
      case 'stop_logging':
        this.logging = false;
        if (this.smpTimer) clearInterval(this.smpTimer);
        this.smpTimer = null;
        return this.reply(id, {});
      case 'get_count':
        return this.reply(id, { count: this.records.length / 22, record_size: 22, format: '<BIBIhhHHHH>' });
      case 'clear_data':
        if (this.logging) return this.reply(id, null, { code: 'busy', message: 'logging' });
        this.records = new Uint8Array(0);
        return this.reply(id, {});
      case 'dump':
        return this.dump(id, p);
      default:
        return this.reply(id, null, { code: 'unknown_command', message: String(msg.command) });
    }
  }

  private dump(id: number, p: Record<string, unknown>): void {
    if (this.logging) return this.reply(id, null, { code: 'busy', message: 'stop logging before dump' });
    const total = this.records.length / 22;
    const from = Math.min(Number(p.from ?? 0), total);
    const limitReq = Number(p.limit ?? 0);
    const count = limitReq > 0 ? Math.min(limitReq, total - from) : total - from;
    const attempt = (this.dumpAttempts.get(from) ?? 0) + 1;
    this.dumpAttempts.set(from, attempt);
    const fault = this.opts.dumpFaults?.find((f) => f.from === from && f.attempt === attempt);
    const header = JSON.stringify({ v: 1, id, result: { count, from, record_size: 22, format: '<BIBIhhHHHH>' } }) + '\n';
    const bin = this.records.subarray(from * 22, (from + count) * 22);
    // Header and the first binary bytes share a payload, as observed on BLE.
    const first = Math.min(bin.length, 100);
    const stream = new Uint8Array(utf8(header).length + bin.length);
    stream.set(utf8(header), 0);
    stream.set(bin, utf8(header).length);
    const headerLen = utf8(header).length;
    const sendUpTo = fault ? headerLen + fault.stallAfterBytes : stream.length;
    const chunks: Uint8Array[] = [stream.subarray(0, headerLen + first)];
    for (let i = headerLen + first; i < sendUpTo; i += 220) chunks.push(stream.subarray(i, Math.min(i + 220, sendUpTo)));
    let delay = 0;
    for (const c of chunks) {
      const copy = c.slice();
      setTimeout(() => !this.closed_ && this.payloadL.emit(copy), (delay += 1));
    }
    if (fault) {
      if (fault.lateMs !== undefined) {
        const rest = stream.slice(sendUpTo);
        const step = fault.lateChunkMs;
        const parts: Uint8Array[] = [];
        if (step === undefined) parts.push(rest);
        else for (let i = 0; i < rest.length; i += 220) parts.push(rest.subarray(i, i + 220));
        parts.forEach((part, k) => {
          setTimeout(() => {
            if (this.closed_) return;
            this.lateEmitted += 1;
            this.payloadL.emit(part);
          }, fault.lateMs! + k * (step ?? 0));
        });
      }
      return;
    }
    setTimeout(() => this.emitEvent('dump_end', { sent: count }), delay + 2);
  }

  private reply(id: number, result: unknown, error?: { code: string; message: string }): void {
    const msg = error ? { v: 1, id, error } : { v: 1, id, result };
    this.sendText(JSON.stringify(msg) + '\n');
  }

  private sendText(text: string): void {
    const bytes = utf8(text);
    let delay = 0;
    for (let i = 0; i < bytes.length; i += 220) {
      const c = bytes.slice(i, i + 220);
      setTimeout(() => !this.closed_ && this.payloadL.emit(c), (delay += 1));
    }
  }
}

function sampleData(): SmpData {
  return { t: 23.45, h: 55.2, g: 24.1, c: 425 };
}

/** Build `n` synthetic records with known contents. */
export function makeRecords(n: number, t0 = 1_767_225_600): Uint8Array {
  const buf = new Uint8Array(n * 22);
  const dv = new DataView(buf.buffer);
  for (let i = 0; i < n; i++) {
    const o = i * 22;
    dv.setUint8(o, 3);
    dv.setUint32(o + 1, t0 + i * 5, true);
    dv.setUint8(o + 5, 0b1001110); // t_dry, t_glb, humidity, co2
    dv.setUint32(o + 6, 0, true);
    dv.setInt16(o + 10, 2000 + (i % 500), true);
    dv.setInt16(o + 12, 2100 + (i % 300), true);
    dv.setUint16(o + 14, 5000 + (i % 1000), true);
    dv.setUint16(o + 16, 0, true);
    dv.setUint16(o + 18, 0, true);
    dv.setUint16(o + 20, 400 + (i % 600), true);
  }
  return buf;
}
