/**
 * Simulated M-Logger for demo mode: speaks the same v4 JSON-lines protocol as the firmware
 * over a PayloadLink, with plausible indoor-climate data. State (settings, logging, flash
 * log) persists across reconnects, like a real unit.
 *
 * Timing mirrors the firmware: samples on wall-clock multiples of each category interval,
 * TH/CO2 probe warm-up ~22 s (only globe reported, `wu:["g"]`), velocity warm-up 10 s.
 */
import { LinkError, type LinkStats, type PayloadLink } from '../ble/xbee-link';
import { utf8 } from '../util/bytes';
import { Listeners, type Unsubscribe } from '../util/emitter';
import { RECORD_SIZE } from '../protocol/record';
import type { Correction, Settings, SmpData, Transports } from '../protocol/types';

export interface SimProfile {
  name: string;
  hardwareId: string;
  seed: number;
  baseT: number;
  baseRH: number;
  /** Globe minus air temperature offset (radiant asymmetry), K. */
  dGlobe: number;
  baseV: number;
  baseLux: number;
  baseCO2: number;
}

export const DEMO_PROFILES: readonly SimProfile[] = [
  { name: 'MLogger_D001', hardwareId: 'D3M00001', seed: 11, baseT: 24.2, baseRH: 48, dGlobe: 0.6, baseV: 0.12, baseLux: 620, baseCO2: 620 },
  { name: 'MLogger_D002', hardwareId: 'D3M00002', seed: 23, baseT: 25.6, baseRH: 44, dGlobe: 1.4, baseV: 0.08, baseLux: 820, baseCO2: 540 },
  { name: 'MLogger_D003', hardwareId: 'D3M00003', seed: 37, baseT: 23.1, baseRH: 52, dGlobe: 0.2, baseV: 0.21, baseLux: 410, baseCO2: 760 },
  { name: 'MLogger_D004', hardwareId: 'D3M00004', seed: 41, baseT: 26.3, baseRH: 41, dGlobe: 2.1, baseV: 0.05, baseLux: 1050, baseCO2: 480 },
  { name: 'MLogger_D005', hardwareId: 'D3M00005', seed: 53, baseT: 22.4, baseRH: 55, dGlobe: -0.4, baseV: 0.15, baseLux: 380, baseCO2: 900 },
  { name: 'MLogger_D006', hardwareId: 'D3M00006', seed: 67, baseT: 24.9, baseRH: 46, dGlobe: 0.9, baseV: 0.1, baseLux: 700, baseCO2: 650 },
  { name: 'MLogger_D007', hardwareId: 'D3M00007', seed: 71, baseT: 21.7, baseRH: 58, dGlobe: -0.8, baseV: 0.25, baseLux: 300, baseCO2: 1100 },
  { name: 'MLogger_D008', hardwareId: 'D3M00008', seed: 83, baseT: 25.2, baseRH: 43, dGlobe: 1.6, baseV: 0.07, baseLux: 960, baseCO2: 560 },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/** Smooth, deterministic indoor climate signal. */
class Climate {
  private readonly rng: () => number;
  private walkT = 0;
  private walkH = 0;
  private walkV = 0;
  private walkC = 0;
  private readonly p: SimProfile;

  constructor(p: SimProfile) {
    this.p = p;
    this.rng = mulberry32(p.seed);
  }

  sample(tsSec: number): { t: number; h: number; g: number; v: number; vv: number; l: number; c: number } {
    const r = () => this.rng() - 0.5;
    this.walkT = 0.985 * this.walkT + 0.06 * r();
    this.walkH = 0.98 * this.walkH + 0.25 * r();
    this.walkV = 0.9 * this.walkV + 0.03 * r();
    this.walkC = 0.97 * this.walkC + 12 * r();
    const d = new Date(tsSec * 1000);
    const hour = d.getHours() + d.getMinutes() / 60;
    const diurnal = Math.sin(((hour - 9) / 24) * 2 * Math.PI);
    const occupied = hour >= 8.5 && hour <= 18.5 ? 1 : 0.15;
    const t = this.p.baseT + 0.9 * diurnal + this.walkT;
    const h = this.p.baseRH - 3 * diurnal + this.walkH;
    const g = t + this.p.dGlobe + 0.25 * diurnal + 0.3 * this.walkT;
    const v = Math.max(0.01, this.p.baseV + this.walkV);
    const l = occupied > 0.5 ? this.p.baseLux * (0.92 + 0.08 * Math.cos(hour)) + 15 * r() : 3 + 2 * this.rng();
    const c = this.p.baseCO2 + 380 * occupied * (0.6 + 0.4 * Math.sin(hour * 1.3)) + this.walkC;
    return {
      t: round(t, 2),
      h: round(Math.min(99, Math.max(5, h)), 1),
      g: round(g, 2),
      v: round(v, 3),
      vv: Math.round(380 + v * 2400),
      l: Math.max(0, Math.round(l)),
      c: Math.max(400, Math.round(c)),
    };
  }
}

export class SimDevice {
  readonly profile: SimProfile;
  name: string;
  settings: Settings = {
    general: { enabled: true, interval: 5 },
    velocity: { enabled: true, interval: 10 },
    illuminance: { enabled: true, interval: 10 },
    start_ts: 0,
  };
  correction: Correction = {
    t_dry: { a: 1, b: 0 },
    humidity: { a: 1, b: 0 },
    t_glb: { a: 1, b: 0 },
    illuminance: { a: 1, b: 0 },
    velocity: { a: 1, b: 0 },
  };
  logging = false;
  transports: Transports = { zigbee: false, ble: false, flash: false, usb: false };
  batteryMv = 2780;
  gen = 1;
  private records: Uint8Array | null = null;
  private readonly climate: Climate;
  private link: SimLink | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private loggingSince = 0;
  private clockOffset = 0;

  constructor(profile: SimProfile) {
    this.profile = profile;
    this.name = profile.name;
    this.climate = new Climate(profile);
  }

  /** Open a new "BLE connection" to this device. */
  connect(): SimLink {
    if (this.link && !this.link.closed) throw new Error('already connected');
    this.link = new SimLink(this);
    return this.link;
  }

  /** @internal called by SimLink when the connection drops */
  onDisconnected(): void {
    this.link = null;
    // Firmware: BLE-only logging stops when the BLE client disconnects.
    if (this.logging && this.transports.ble && !this.transports.flash && !this.transports.zigbee) this.stop();
  }

  private nowSec(): number {
    return Math.floor(Date.now() / 1000) + this.clockOffset;
  }

  private stop(): void {
    this.logging = false;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  private start(): void {
    this.logging = true;
    this.loggingSince = this.nowSec();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 1000);
  }

  private tick(): void {
    const now = this.nowSec();
    if (this.settings.start_ts > now) return;
    const due = (c: keyof Omit<Settings, 'start_ts'>) =>
      this.settings[c].enabled && now % Math.max(1, this.settings[c].interval) === 0;
    const g = due('general');
    const v = due('velocity');
    const l = due('illuminance');
    if (!g && !v && !l) return;
    const s = this.climate.sample(now);
    const data: SmpData = {};
    const wu: Array<'g' | 'v' | 'l'> = [];
    const elapsed = now - this.loggingSince;
    if (g) {
      data.g = s.g;
      if (elapsed < 22) wu.push('g');
      else {
        data.t = s.t;
        data.h = s.h;
        data.c = s.c;
      }
    }
    if (v) {
      if (elapsed < 10) wu.push('v');
      else {
        data.v = s.v;
        data.vv = s.vv;
      }
    }
    if (l) data.l = s.l;
    if (wu.length) data.wu = wu;
    this.batteryMv = Math.max(2300, this.batteryMv - 0.002);
    if (this.transports.ble) this.link?.emitLine({ v: 1, event: 'smp', ts: now, data });
  }

  /** Synthetic flash history: ~2 days at 60 s, generated on first use. */
  private flash(): Uint8Array {
    if (this.records) return this.records;
    const n = 2880;
    const buf = new Uint8Array(n * RECORD_SIZE);
    const dv = new DataView(buf.buffer);
    const climate = new Climate({ ...this.profile, seed: this.profile.seed + 1000 });
    const t0 = Math.floor(Date.now() / 1000 / 60) * 60 - n * 60;
    for (let i = 0; i < n; i++) {
      const o = i * RECORD_SIZE;
      const s = climate.sample(t0 + i * 60);
      dv.setUint8(o, this.gen);
      dv.setUint32(o + 1, t0 + i * 60, true);
      dv.setUint8(o + 5, 0b1111111);
      dv.setUint32(o + 6, Math.round(s.l * 10), true);
      dv.setInt16(o + 10, Math.round(s.t * 100), true);
      dv.setInt16(o + 12, Math.round(s.g * 100), true);
      dv.setUint16(o + 14, Math.round(s.h * 100), true);
      dv.setUint16(o + 16, Math.round(s.v * 10000), true);
      dv.setUint16(o + 18, s.vv, true);
      dv.setUint16(o + 20, s.c, true);
    }
    this.records = buf;
    return buf;
  }

  /** @internal */
  handle(msg: { id: number; command: string; params: Record<string, unknown> }, link: SimLink): void {
    const { id, command, params: p } = msg;
    const ok = (result: unknown) => link.emitLine({ v: 1, id, result });
    const err = (code: string, message: string) => link.emitLine({ v: 1, id, error: { code, message } });
    switch (command) {
      case 'hello':
        return ok({
          device: 'M-Logger',
          firmware_version: '4.0.1-demo',
          protocol_version: 1,
          hardware_id: this.profile.hardwareId,
          name: this.name,
          logging: this.logging,
        });
      case 'get_battery':
        return ok({ voltage_mv: Math.round(this.batteryMv), low_battery: this.batteryMv < 1800 });
      case 'get_settings':
        return ok(this.settings);
      case 'set_settings': {
        for (const k of ['general', 'velocity', 'illuminance'] as const) {
          const patch = p[k] as Partial<Settings['general']> | undefined;
          if (!patch) continue;
          if (patch.interval !== undefined && (patch.interval < 1 || patch.interval > 99999)) {
            return err('out_of_range', `${k}.interval`);
          }
        }
        for (const k of ['general', 'velocity', 'illuminance'] as const) {
          if (p[k]) Object.assign(this.settings[k], p[k]);
        }
        if (typeof p.start_ts === 'number') this.settings.start_ts = p.start_ts;
        return ok(this.settings);
      }
      case 'get_correction':
        return ok(this.correction);
      case 'set_correction':
        for (const k of Object.keys(this.correction) as Array<keyof Correction>) {
          if (p[k]) Object.assign(this.correction[k], p[k]);
        }
        return ok(this.correction);
      case 'set_time':
        this.clockOffset = Number(p.ts) - Math.floor(Date.now() / 1000);
        return ok({ ts: p.ts });
      case 'set_name':
        this.name = String(p.name).slice(0, 20);
        return ok({ name: this.name });
      case 'get_probe_info':
        return ok({
          th_probe: { connected: true, device_id: '00D3M0', name: '', data_count: 4 },
          velocity_probe: { connected: true, device_id: '00D3M1', name: '', data_count: 2 },
        });
      case 'start_logging': {
        const t = { ...this.transports, ...(p.transports as Partial<Transports>) };
        if (!t.zigbee && !t.ble && !t.flash && !t.usb) return err('invalid_params', 'no transport');
        this.transports = t;
        ok({});
        this.start();
        return;
      }
      case 'stop_logging':
        this.stop();
        return ok({});
      case 'get_count':
        return ok({ count: this.flash().length / RECORD_SIZE, record_size: RECORD_SIZE, format: '<BIBIhhHHHH>' });
      case 'clear_data':
        if (this.logging) return err('busy', 'logging');
        this.records = new Uint8Array(0);
        this.gen += 1;
        return ok({});
      case 'calibrate_co2':
        if (this.logging) return err('busy', 'logging');
        ok({});
        if (p.mode === 'forced') {
          for (let s = 0; s <= 35; s++) {
            setTimeout(() => {
              link.emitLine({
                v: 1,
                event: 'co2_calibration_progress',
                ts: this.nowSec(),
                data: {
                  remaining_s: 35 - s,
                  state: s === 35 ? 'pass' : 'measuring',
                  correction_ppm: s === 35 ? -12 : 0,
                  current_ppm: 431 + Math.round(Math.sin(s) * 3),
                },
              });
            }, s * 1000);
          }
        }
        return;
      case 'dump': {
        if (this.logging) return err('busy', 'stop logging before dump');
        const recs = this.flash();
        const total = recs.length / RECORD_SIZE;
        const from = Math.min(Number(p.from ?? 0), total);
        const limit = Number(p.limit ?? 0);
        const count = limit > 0 ? Math.min(limit, total - from) : total - from;
        link.emitLine({ v: 1, id, result: { count, from, record_size: RECORD_SIZE, format: '<BIBIhhHHHH>' } });
        link.emitBinary(recs.subarray(from * RECORD_SIZE, (from + count) * RECORD_SIZE), () =>
          link.emitLine({ v: 1, event: 'dump_end', ts: this.nowSec(), data: { sent: count } }),
        );
        return;
      }
      default:
        return err('unknown_command', command);
    }
  }
}

/** PayloadLink to a SimDevice. */
export class SimLink implements PayloadLink {
  readonly transportId: string;
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
  private closed_ = false;
  private readonly payloadL = new Listeners<[Uint8Array]>();
  private readonly closeL = new Listeners<[LinkError]>();
  private buf = '';
  private pending = false;
  private readonly device: SimDevice;
  private outChain: Promise<void> = Promise.resolve();

  constructor(device: SimDevice) {
    this.device = device;
    this.transportId = `sim-${device.profile.hardwareId}`;
  }

  get closed(): boolean {
    return this.closed_;
  }

  async sendLine(line: Uint8Array): Promise<void> {
    if (this.closed_) throw new LinkError('closed', 'closed');
    this.stats.txBytes += line.length;
    await new Promise((r) => setTimeout(r, 60)); // BLE write latency
    for (const ch of new TextDecoder().decode(line)) {
      if (this.pending) continue; // firmware drops bytes while a line is pending
      if (ch === '\n' || ch === '\r') {
        if (!this.buf) continue;
        const l = this.buf;
        this.buf = '';
        this.pending = true;
        setTimeout(() => {
          this.pending = false;
          if (this.closed_) return;
          try {
            const msg = JSON.parse(l) as { id: number; command: string; params?: Record<string, unknown> };
            this.device.handle({ id: msg.id, command: msg.command, params: msg.params ?? {} }, this);
          } catch {
            this.emitLine({ v: 1, id: 0, error: { code: 'invalid_params', message: 'json' } });
          }
        }, 25);
      } else this.buf += ch;
    }
  }

  onPayload(cb: (b: Uint8Array) => void): Unsubscribe {
    return this.payloadL.add(cb);
  }

  onClose(cb: (e: LinkError) => void): Unsubscribe {
    return this.closeL.add(cb);
  }

  close(reason = 'closed by client'): void {
    this.end(new LinkError(reason, 'closed'));
  }

  /** Simulate losing the radio link. */
  drop(): void {
    this.end(new LinkError('device disconnected', 'disconnected'));
  }

  private end(err: LinkError): void {
    if (this.closed_) return;
    this.closed_ = true;
    this.device.onDisconnected();
    this.closeL.emit(err);
  }

  /** @internal */
  emitLine(obj: unknown): void {
    this.enqueue(utf8(JSON.stringify(obj) + '\n'), 40);
  }

  /** @internal Binary stream at ~2.4 kB/s in 220-byte frames. */
  emitBinary(bytes: Uint8Array, done: () => void): void {
    for (let i = 0; i < bytes.length; i += 220) this.enqueue(bytes.slice(i, i + 220), 90);
    this.outChain = this.outChain.then(() => done());
  }

  private enqueue(bytes: Uint8Array, delayMs: number): void {
    this.outChain = this.outChain.then(
      () =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            if (!this.closed_) {
              this.stats.rxBytes += bytes.length;
              this.stats.lastRxAt = Date.now();
              this.payloadL.emit(bytes);
            }
            resolve();
          }, delayMs),
        ),
    );
  }
}
