/**
 * PC-side recording of live samples into IndexedDB.
 *
 * - Samples are buffered per device and appended as small column-oriented chunks about every
 *   2 s. Flushes are triggered by incoming samples (BLE events keep arriving in background
 *   tabs, timers may not) with a timer as a fallback; nothing is ever rewritten.
 * - A crash or reload loses at most the last flush interval; such sessions are found at the
 *   next start (status still 'recording') and marked 'interrupted' so they can be exported
 *   or continued.
 * - QuotaExceededError stops saving (live view continues) and is reported.
 */
import type { ComfortConditions } from '../comfort/comfort';
import type { DeviceController } from '../device/controller';
import type { SmpEvent, Transports } from '../protocol/types';
import { encodeFlags } from './series';
import { Listeners, type Unsubscribe } from '../util/emitter';
import { newId, type ChunkRecord, type Db, type EventRecord, type SessionDevice, type SessionRecord } from './db';

interface Pending {
  ts: number[];
  t: number[];
  h: number[];
  g: number[];
  v: number[];
  vv: number[];
  l: number[];
  c: number[];
  flags: number[];
}

const emptyPending = (): Pending => ({ ts: [], t: [], h: [], g: [], v: [], vv: [], l: [], c: [], flags: [] });
const val = (x: number | null | undefined) => (typeof x === 'number' ? x : NaN);

export interface RecorderDevice {
  controller: DeviceController;
  colorIndex: number;
}

export interface RecorderStatus {
  session: SessionRecord | null;
  samples: number;
  error: 'quota' | string | null;
}

export class Recorder {
  readonly db: Db;
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly appVersion: string;
  private session: SessionRecord | null = null;
  private readonly pending = new Map<string, Pending>();
  private readonly seq = new Map<string, number>();
  private readonly subs = new Map<string, Unsubscribe>();
  private readonly controllers = new Map<string, DeviceController>();
  private lastFlush = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private error: RecorderStatus['error'] = null;
  private readonly statusL = new Listeners<[RecorderStatus]>();

  constructor(db: Db, opts: { now?: () => number; flushMs?: number; appVersion?: string } = {}) {
    this.db = db;
    this.now = opts.now ?? (() => Date.now());
    this.flushMs = opts.flushMs ?? 2000;
    this.appVersion = opts.appVersion ?? '0.0.0';
  }

  get active(): SessionRecord | null {
    return this.session;
  }

  onStatus(cb: (s: RecorderStatus) => void): Unsubscribe {
    return this.statusL.add(cb);
  }

  private emit(): void {
    this.statusL.emit({ session: this.session, samples: this.session?.samples ?? 0, error: this.error });
  }

  /** Mark sessions left in 'recording' (tab closed / crashed) as interrupted. */
  static async recoverInterrupted(db: Db): Promise<SessionRecord[]> {
    const all = await db.getAll('sessions');
    const out: SessionRecord[] = [];
    for (const s of all.filter((x) => x.status === 'recording')) {
      s.status = 'interrupted';
      await db.put('sessions', s);
      out.push(s);
    }
    return out;
  }

  async start(params: {
    title: string;
    conditions: ComfortConditions;
    transports: Transports;
    devices: RecorderDevice[];
  }): Promise<SessionRecord> {
    if (this.session) throw new Error('a recording is already running');
    const session: SessionRecord = {
      id: newId(this.now()),
      title: params.title,
      startedAt: this.now(),
      endedAt: null,
      status: 'recording',
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      appVersion: this.appVersion,
      conditions: { ...params.conditions },
      devices: [],
      samples: 0,
    };
    await this.db.put('sessions', session);
    this.session = session;
    this.error = null;
    for (const d of params.devices) await this.join(d, params.transports);
    await this.logEvent('start', null);
    this.startTimer();
    this.emit();
    return session;
  }

  /** Continue an interrupted (or stopped) session. */
  async resume(sessionId: string, devices: RecorderDevice[], transports: Transports): Promise<SessionRecord> {
    if (this.session) throw new Error('a recording is already running');
    // Checked and marked 'recording' in one transaction, so a deletion in this or another tab
    // either has started (and the session is refused) or will be refused (see deleteSession).
    const tx = this.db.transaction('sessions', 'readwrite');
    const session = await tx.store.get(sessionId);
    if (!session) throw new Error('session not found');
    if (session.status === 'deleting') throw new Error('the session is being deleted');
    if (session.status === 'recording') throw new Error('the session is already being recorded');
    session.status = 'recording';
    session.endedAt = null;
    await tx.store.put(session);
    await tx.done;
    this.session = session;
    this.error = null;
    for (const d of devices) await this.join(d, transports);
    await this.logEvent('start', null, 'resumed');
    this.startTimer();
    this.emit();
    return session;
  }

  isMember(hardwareId: string): boolean {
    return this.subs.has(hardwareId);
  }

  /** Add a device to the running session (idempotent). */
  async join(d: RecorderDevice, transports: Transports): Promise<void> {
    const s = this.session;
    if (!s) throw new Error('no active recording');
    const meta = d.controller.snapshot.meta;
    const hwid = meta.hardwareId;
    if (!hwid) throw new Error('device identity unknown (not connected yet)');
    if (this.subs.has(hwid)) return;
    let entry = s.devices.find((x) => x.hardwareId === hwid);
    if (!entry) {
      entry = {
        hardwareId: hwid,
        name: meta.name ?? hwid,
        firmware: meta.firmware,
        colorIndex: d.colorIndex,
        settings: meta.settings,
        transports,
        joinedAt: this.now(),
        leftAt: null,
        samples: 0,
      } satisfies SessionDevice;
      s.devices.push(entry);
    } else {
      entry.leftAt = null;
      entry.settings = meta.settings ?? entry.settings;
    }
    // continue the chunk sequence after a resume
    const range = IDBKeyRange.bound([s.id, hwid, -Infinity], [s.id, hwid, Infinity]);
    const last = await this.db.transaction('chunks').store.openCursor(range, 'prev');
    this.seq.set(hwid, last ? (last.value.seq ?? 0) + 1 : 0);
    this.pending.set(hwid, emptyPending());
    this.subs.set(hwid, d.controller.onSample((e) => this.push(hwid, e)));
    this.controllers.set(hwid, d.controller);
    d.controller.keepAlive = true;
    await this.db.put('sessions', s);
    await this.logEvent('join', hwid);
    this.emit();
  }

  async leave(hardwareId: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    await this.flush();
    this.subs.get(hardwareId)?.();
    this.subs.delete(hardwareId);
    const ctrl = this.controllers.get(hardwareId);
    if (ctrl) ctrl.keepAlive = false;
    this.controllers.delete(hardwareId);
    const entry = s.devices.find((x) => x.hardwareId === hardwareId);
    if (entry) entry.leftAt = this.now();
    await this.db.put('sessions', s);
    await this.logEvent('leave', hardwareId);
    this.emit();
  }

  private push(hwid: string, e: SmpEvent): void {
    const p = this.pending.get(hwid);
    if (!p || !this.session) return;
    const d = e.data;
    p.ts.push(e.ts);
    p.t.push(val(d.t));
    p.h.push(val(d.h));
    p.g.push(val(d.g));
    p.v.push(val(d.v));
    p.vv.push(val(d.vv));
    p.l.push(val(d.l));
    p.c.push(val(d.c));
    p.flags.push(encodeFlags(d));
    if (this.now() - this.lastFlush >= this.flushMs) void this.flush();
  }

  /** Write buffered samples (serialised; safe to call any time). */
  flush(): Promise<void> {
    const run = this.chain.then(() => this.flushNow());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async flushNow(): Promise<void> {
    const s = this.session;
    this.lastFlush = this.now();
    if (!s) return;
    const chunks: ChunkRecord[] = [];
    for (const [hwid, p] of this.pending) {
      if (p.ts.length === 0) continue;
      const seq = this.seq.get(hwid) ?? 0;
      this.seq.set(hwid, seq + 1);
      chunks.push({
        sessionId: s.id,
        hardwareId: hwid,
        seq,
        t0: p.ts[0]!,
        t1: p.ts[p.ts.length - 1]!,
        n: p.ts.length,
        ts: Float64Array.from(p.ts),
        t: Float32Array.from(p.t),
        h: Float32Array.from(p.h),
        g: Float32Array.from(p.g),
        v: Float32Array.from(p.v),
        vv: Float32Array.from(p.vv),
        l: Float32Array.from(p.l),
        c: Float32Array.from(p.c),
        flags: Uint16Array.from(p.flags),
      });
      this.pending.set(hwid, emptyPending());
    }
    if (chunks.length === 0 || this.error === 'quota') return;
    for (const c of chunks) {
      const dev = s.devices.find((d) => d.hardwareId === c.hardwareId);
      if (dev) dev.samples += c.n;
      s.samples += c.n;
    }
    try {
      const tx = this.db.transaction(['chunks', 'sessions'], 'readwrite', { durability: 'relaxed' });
      for (const c of chunks) await tx.objectStore('chunks').put(c);
      await tx.objectStore('sessions').put(s);
      await tx.done;
    } catch (err) {
      for (const c of chunks) {
        const dev = s.devices.find((d) => d.hardwareId === c.hardwareId);
        if (dev) dev.samples -= c.n;
        s.samples -= c.n;
      }
      this.error = err instanceof DOMException && err.name === 'QuotaExceededError' ? 'quota' : String(err);
    }
    this.emit();
  }

  async logEvent(kind: EventRecord['kind'], hardwareId: string | null, detail?: string): Promise<void> {
    const s = this.session;
    if (!s) return;
    try {
      await this.db.add('events', { sessionId: s.id, hardwareId, at: this.now(), kind, ...(detail ? { detail } : {}) });
    } catch {
      // events are best effort
    }
  }

  async stop(): Promise<SessionRecord | null> {
    const s = this.session;
    if (!s) return null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    await this.logEvent('stop', null);
    for (const u of this.subs.values()) u();
    this.subs.clear();
    for (const c of this.controllers.values()) c.keepAlive = false;
    this.controllers.clear();
    this.pending.clear();
    s.status = 'stopped';
    s.endedAt = this.now();
    const tx = this.db.transaction('sessions', 'readwrite', { durability: 'strict' });
    await tx.store.put(s);
    await tx.done;
    this.session = null;
    this.emit();
    return s;
  }

  private startTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (this.now() - this.lastFlush >= this.flushMs) void this.flush();
    }, this.flushMs);
  }
}
