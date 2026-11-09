/**
 * M-Logger v4 JSON-lines client over a PayloadLink.
 *
 * - Exactly ONE request in flight per device: the firmware discards bytes from a source
 *   while a received line is still pending (command_handler.c), so pipelining loses commands.
 * - A gap after each response (300 ms; the official app found writes right after a
 *   notification could be lost) and a longer cool-down after a timeout.
 * - Three priority lanes; an exclusive lease (for dumps) suspends everything else.
 * - Responses are matched by id (ids start at 1 — the firmware answers unparseable lines with id 0).
 */
import type { PayloadLink } from '../ble/xbee-link';
import { utf8 } from '../util/bytes';
import { Listeners, type Unsubscribe } from '../util/emitter';
import { COMMAND_POLICY, type CommandName, type ParamsOf, type ResultOf } from './commands';
import {
  AbortedError,
  ClientClosedError,
  CommandTimeoutError,
  DumpError,
  DumpStallError,
  ProtocolError,
} from './errors';
import { LineDecoder } from './line-decoder';
import { RECORD_SIZE } from './record';
import type {
  Co2CalibrationProgress,
  DumpEnd,
  DumpHeader,
  ReadyEvent,
  SensorCategoryId,
  SmpData,
  SmpEvent,
  TimeSyncRequest,
} from './types';

export type Priority = 'urgent' | 'normal' | 'background';

export interface CallOptions {
  priority?: Priority;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Override the per-command retry policy. */
  retry?: boolean;
}

export interface ClientOptions {
  /** Pause after each response before the next request. */
  gapMs?: number;
  /** Pause after a timeout (the firmware may still be holding the previous line). */
  timeoutCooldownMs?: number;
  now?: () => number;
}

export interface ClientEventMap {
  smp: SmpEvent;
  ready: ReadyEvent;
  co2_calibration_progress: Co2CalibrationProgress;
  time_sync_request: TimeSyncRequest;
  dump_end: DumpEnd;
  /** A line that is not JSON or not a known message (diagnostics). */
  unparsed: string;
  /** Raw line traffic, for the diagnostics log. */
  traffic: { dir: 'tx' | 'rx'; line: string; at: number };
  closed: Error;
}

export interface ClientStats {
  sent: number;
  timeouts: number;
  retries: number;
  lastRttMs: number;
}

export interface DumpBlockOptions {
  stallMs: number;
  onBytes?: (n: number) => void;
  signal?: AbortSignal;
}

/** Exclusive access to the device (used by the dump job). */
export interface ExclusiveLease {
  call<K extends CommandName>(command: K, params: ParamsOf<K>, opts?: CallOptions): Promise<ResultOf<K>>;
  /** Request `limit` records from `from` and fill `into` (exactly limit × 22 bytes). */
  dumpBlock(from: number, limit: number, into: Uint8Array, opts: DumpBlockOptions): Promise<DumpHeader>;
  /** Wait until nothing has been received for `quietMs` (gives up after `maxMs`). */
  waitRxQuiet(quietMs: number, maxMs: number): Promise<boolean>;
  /** Drop any partial line (after late binary bytes). */
  resetDecoder(): void;
  /**
   * Give up on the link: its byte stream can no longer be put back in step (the device keeps
   * sending). Closes the client and the link; the device controller reconnects.
   */
  closeLink(reason: string): void;
  release(): void;
}

type Lane = Priority | 'lease';

interface DumpState {
  from: number;
  limit: number;
  into: Uint8Array;
  expected: number;
  received: number;
  stallMs: number;
  onBytes?: (n: number) => void;
  stallTimer: ReturnType<typeof setTimeout> | null;
}

interface Job {
  command: string;
  params: unknown;
  timeoutMs: number;
  retry: boolean;
  attempts: number;
  lane: Lane;
  signal: AbortSignal | undefined;
  cancelled: boolean;
  resolve(value: unknown): void;
  reject(err: Error): void;
  dump?: DumpState;
}

interface Inflight {
  job: Job;
  id: number;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const MAX_ID = 0x7fffffff;

export class MLoggerClient {
  private readonly link: PayloadLink;
  private readonly gapMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly lanes: Record<Lane, Job[]> = { lease: [], urgent: [], normal: [], background: [] };
  private inflight: Inflight | null = null;
  private nextId = 1;
  private nextAllowedAt = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | null = null;
  private lease: Lease | null = null;
  private readonly leaseWaiters: Array<{ grant(): void; reject(e: Error): void }> = [];
  private readonly decoder: LineDecoder;
  private readonly listeners = new Map<keyof ClientEventMap, Listeners<[unknown]>>();
  private closedError: Error | null = null;
  private lastRx = 0;
  readonly stats: ClientStats = { sent: 0, timeouts: 0, retries: 0, lastRttMs: 0 };

  constructor(link: PayloadLink, opts: ClientOptions = {}) {
    this.link = link;
    this.gapMs = opts.gapMs ?? 300;
    this.cooldownMs = opts.timeoutCooldownMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
    this.decoder = new LineDecoder((line) => this.onLine(line));
    link.onPayload((bytes) => {
      this.lastRx = this.now();
      this.decoder.push(bytes);
    });
    link.onClose((err) => this.dispose(err));
  }

  get closed(): boolean {
    return this.closedError !== null;
  }

  /** Time of the last received byte (ms). */
  get lastRxAt(): number {
    return this.lastRx;
  }

  get pending(): number {
    return (
      (this.inflight ? 1 : 0) +
      this.lanes.lease.length +
      this.lanes.urgent.length +
      this.lanes.normal.length +
      this.lanes.background.length
    );
  }

  on<E extends keyof ClientEventMap>(event: E, cb: (e: ClientEventMap[E]) => void): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Listeners<[unknown]>();
      this.listeners.set(event, set);
    }
    return set.add(cb as (e: unknown) => void);
  }

  private emit<E extends keyof ClientEventMap>(event: E, payload: ClientEventMap[E]): void {
    this.listeners.get(event)?.emit(payload);
  }

  call<K extends CommandName>(command: K, params: ParamsOf<K>, opts: CallOptions = {}): Promise<ResultOf<K>> {
    return this.enqueue(command, params, opts, opts.priority ?? 'normal') as Promise<ResultOf<K>>;
  }

  /** Exclusive access: waits for the in-flight request, then holds off every other caller. */
  acquireExclusive(signal?: AbortSignal): Promise<ExclusiveLease> {
    if (this.closedError) return Promise.reject(this.closedError);
    return new Promise<ExclusiveLease>((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          const lease = new Lease(this);
          this.lease = lease;
          resolve(lease);
        },
        reject: (e: Error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        },
      };
      const onAbort = () => {
        const i = this.leaseWaiters.indexOf(waiter);
        if (i >= 0) this.leaseWaiters.splice(i, 1);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.leaseWaiters.push(waiter);
      this.schedule();
    });
  }

  dispose(cause?: Error): void {
    if (this.closedError) return;
    const err = new ClientClosedError(cause?.message ?? 'connection closed', { cause });
    this.closedError = err;
    if (this.pumpTimer) clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    const inf = this.inflight;
    this.inflight = null;
    if (inf) {
      if (inf.timer) clearTimeout(inf.timer);
      if (inf.job.dump?.stallTimer) clearTimeout(inf.job.dump.stallTimer);
      if (!inf.job.cancelled) inf.job.reject(err);
    }
    for (const lane of Object.values(this.lanes)) {
      for (const job of lane.splice(0)) job.reject(err);
    }
    for (const w of this.leaseWaiters.splice(0)) w.reject(err);
    this.emit('closed', err);
  }

  // ---------------------------------------------------------------- queue

  /** @internal */
  enqueue(command: string, params: unknown, opts: CallOptions, lane: Lane, dump?: DumpState): Promise<unknown> {
    if (this.closedError) return Promise.reject(this.closedError);
    const policy = COMMAND_POLICY[command as CommandName] ?? { timeoutMs: 5000, retry: false };
    return new Promise((resolve, reject) => {
      const job: Job = {
        command,
        params,
        timeoutMs: opts.timeoutMs ?? policy.timeoutMs,
        retry: opts.retry ?? policy.retry,
        attempts: 0,
        lane,
        signal: opts.signal,
        cancelled: false,
        resolve,
        reject,
        dump,
      };
      if (opts.signal) {
        if (opts.signal.aborted) return reject(new AbortedError());
        opts.signal.addEventListener(
          'abort',
          () => {
            const q = this.lanes[lane];
            const i = q.indexOf(job);
            if (i >= 0) {
              q.splice(i, 1);
              reject(new AbortedError());
            } else if (this.inflight?.job === job) {
              // Keep the slot until the device answers or times out (one-in-flight), but release the caller now.
              job.cancelled = true;
              reject(new AbortedError());
            }
          },
          { once: true },
        );
      }
      this.lanes[lane].push(job);
      this.schedule();
    });
  }

  private nextJob(): Job | undefined {
    if (this.lease) return this.lanes.lease.shift();
    return this.lanes.urgent.shift() ?? this.lanes.normal.shift() ?? this.lanes.background.shift();
  }

  private hasRunnable(): boolean {
    if (this.lease) return this.lanes.lease.length > 0;
    return this.lanes.urgent.length + this.lanes.normal.length + this.lanes.background.length > 0;
  }

  private schedule(): void {
    if (this.closedError || this.inflight || this.pumpTimer) return;
    if (!this.lease && this.leaseWaiters.length > 0) {
      this.leaseWaiters.shift()!.grant();
    }
    if (!this.hasRunnable()) return;
    const wait = this.nextAllowedAt - this.now();
    if (wait <= 0) {
      // Send without a timer when possible: timers are throttled in background tabs.
      this.pump();
      return;
    }
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump();
    }, wait);
  }

  private pump(): void {
    if (this.closedError || this.inflight) return;
    const job = this.nextJob();
    if (!job) return;
    const id = this.allocId();
    const msg =
      job.params === undefined
        ? { v: 1, id, command: job.command }
        : { v: 1, id, command: job.command, params: job.params };
    const line = JSON.stringify(msg);
    const inf: Inflight = { job, id, sentAt: this.now(), timer: null };
    inf.timer = setTimeout(() => this.onTimeout(inf), job.timeoutMs);
    this.inflight = inf;
    job.attempts += 1;
    this.stats.sent += 1;
    this.emit('traffic', { dir: 'tx', line, at: inf.sentAt });
    this.link.sendLine(utf8(line + '\n')).catch(() => {
      // The link closes itself on write failure; dispose() will reject this request.
    });
  }

  private allocId(): number {
    const id = this.nextId;
    this.nextId = id >= MAX_ID ? 1 : id + 1;
    return id;
  }

  private onTimeout(inf: Inflight): void {
    if (this.inflight !== inf) return;
    if (inf.job.dump) {
      // Header never arrived.
      this.finish(inf, new CommandTimeoutError('dump', inf.job.timeoutMs));
      return;
    }
    this.stats.timeouts += 1;
    this.finish(inf, new CommandTimeoutError(inf.job.command, inf.job.timeoutMs));
  }

  private finish(inf: Inflight, err: Error | null, result?: unknown): void {
    if (this.inflight !== inf) return;
    this.inflight = null;
    if (inf.timer) clearTimeout(inf.timer);
    if (inf.job.dump?.stallTimer) clearTimeout(inf.job.dump.stallTimer);
    const isTimeout = err instanceof CommandTimeoutError;
    this.nextAllowedAt = this.now() + (isTimeout ? this.cooldownMs : this.gapMs);
    if (!err) this.stats.lastRttMs = this.now() - inf.sentAt;
    const job = inf.job;
    if (err && !job.cancelled && this.shouldRetry(job, err)) {
      this.stats.retries += 1;
      this.lanes[job.lane].unshift(job);
    } else if (!job.cancelled) {
      if (err) job.reject(err);
      else job.resolve(result);
    }
    this.schedule();
  }

  private shouldRetry(job: Job, err: Error): boolean {
    if (!job.retry || job.attempts >= 2 || job.dump) return false;
    return err instanceof CommandTimeoutError || (err instanceof ProtocolError && err.code === 'parse_error');
  }

  // ---------------------------------------------------------------- receive

  private onLine(line: string): void {
    this.emit('traffic', { dir: 'rx', line, at: this.now() });
    const msg = parseLine(line);
    if (!msg) {
      this.emit('unparsed', line);
      return;
    }
    if (typeof msg.id === 'number') this.onResponse(msg);
    else if (typeof msg.event === 'string') this.onEvent(msg);
    else this.emit('unparsed', line);
  }

  private onResponse(msg: Record<string, unknown>): void {
    const inf = this.inflight;
    if (!inf) return; // late answer to a request that already timed out
    if (msg.id === 0) {
      this.finish(inf, new ProtocolError(inf.job.command, 'parse_error', 'device could not parse the request'));
      return;
    }
    if (msg.id !== inf.id) return;
    const error = msg.error as { code?: unknown; message?: unknown } | undefined;
    if (error && typeof error === 'object') {
      this.finish(inf, new ProtocolError(inf.job.command, String(error.code ?? 'error'), String(error.message ?? '')));
      return;
    }
    const result = (msg.result ?? {}) as Record<string, unknown>;
    if (inf.job.dump) {
      this.onDumpHeader(inf, result);
      return;
    }
    this.finish(inf, null, result);
  }

  private onDumpHeader(inf: Inflight, result: Record<string, unknown>): void {
    const d = inf.job.dump!;
    const header: DumpHeader = {
      count: Number(result.count),
      from: Number(result.from),
      record_size: Number(result.record_size),
      format: String(result.format ?? ''),
    };
    if (header.record_size !== RECORD_SIZE || header.from !== d.from || header.count !== d.limit) {
      this.finish(
        inf,
        new DumpError(
          `dump header mismatch: asked ${d.limit}@${d.from}, got ${header.count}@${header.from} (${header.record_size} B/record)`,
        ),
      );
      return;
    }
    if (d.expected === 0) {
      this.finish(inf, null, header);
      return;
    }
    if (inf.timer) clearTimeout(inf.timer);
    inf.timer = null;
    const armStall = () => {
      if (d.stallTimer) clearTimeout(d.stallTimer);
      d.stallTimer = setTimeout(() => {
        if (this.inflight !== inf) return;
        this.decoder.cancelBinary();
        this.finish(inf, new DumpStallError(d.received, d.expected, d.stallMs));
      }, d.stallMs);
    };
    armStall();
    // Switch synchronously: the bytes right after this line may be in the same chunk.
    this.decoder.startBinary(d.expected, (bytes) => {
      if (this.inflight !== inf) return;
      d.into.set(bytes, d.received);
      d.received += bytes.length;
      d.onBytes?.(bytes.length);
      if (d.received >= d.expected) this.finish(inf, null, header);
      else armStall();
    });
  }

  private onEvent(msg: Record<string, unknown>): void {
    const now = this.now();
    const ts = typeof msg.ts === 'number' ? msg.ts : Math.floor(now / 1000);
    const data = (msg.data && typeof msg.data === 'object' ? msg.data : {}) as Record<string, unknown>;
    switch (msg.event) {
      case 'smp':
        this.emit('smp', { ts, data: sanitizeSmp(data), receivedAt: now });
        break;
      case 'ready':
        this.emit('ready', {
          ts,
          receivedAt: now,
          ...(typeof data.uptime_s === 'number' ? { uptime_s: data.uptime_s } : {}),
          ...(typeof data.logging === 'boolean' ? { logging: data.logging } : {}),
          ...(typeof data.name === 'string' ? { name: data.name } : {}),
        });
        break;
      case 'co2_calibration_progress': {
        const state = data.state === 'pass' || data.state === 'fail' ? data.state : 'measuring';
        this.emit('co2_calibration_progress', {
          ts,
          state,
          remaining_s: num(data.remaining_s),
          correction_ppm: num(data.correction_ppm),
          current_ppm: num(data.current_ppm),
        });
        break;
      }
      case 'time_sync_request':
        this.emit('time_sync_request', {
          ts,
          receivedAt: now,
          window_s: typeof data.window_s === 'number' ? data.window_s : 30,
          ...(typeof data.name === 'string' ? { name: data.name } : {}),
        });
        break;
      case 'dump_end':
        this.emit('dump_end', { ts, sent: num(data.sent) });
        break;
      default:
        this.emit('unparsed', JSON.stringify(msg));
    }
  }

  // ---------------------------------------------------------------- lease helpers

  /** @internal */
  releaseLease(lease: Lease): void {
    if (this.lease !== lease) return;
    this.lease = null;
    for (const job of this.lanes.lease.splice(0)) job.reject(new Error('lease released'));
    this.schedule();
  }

  /** @internal */
  async waitRxQuiet(quietMs: number, maxMs: number): Promise<boolean> {
    const start = this.now();
    for (;;) {
      const since = this.now() - this.lastRx;
      if (since >= quietMs) return true;
      if (this.now() - start >= maxMs || this.closedError) return false;
      await new Promise((r) => setTimeout(r, Math.min(quietMs - since, 100)));
    }
  }

  /** @internal */
  resetDecoder(): void {
    this.decoder.reset();
  }

  /** @internal */
  closeLink(reason: string): void {
    this.dispose(new Error(reason));
    this.link.close(reason);
  }
}

class Lease implements ExclusiveLease {
  private released = false;
  private readonly client: MLoggerClient;

  constructor(client: MLoggerClient) {
    this.client = client;
  }

  call<K extends CommandName>(command: K, params: ParamsOf<K>, opts: CallOptions = {}): Promise<ResultOf<K>> {
    if (this.released) return Promise.reject(new Error('lease released'));
    return this.client.enqueue(command, params, opts, 'lease') as Promise<ResultOf<K>>;
  }

  dumpBlock(from: number, limit: number, into: Uint8Array, opts: DumpBlockOptions): Promise<DumpHeader> {
    if (this.released) return Promise.reject(new Error('lease released'));
    const expected = limit * RECORD_SIZE;
    if (into.length < expected) return Promise.reject(new RangeError('dump buffer too small'));
    const state: DumpState = {
      from,
      limit,
      into,
      expected,
      received: 0,
      stallMs: opts.stallMs,
      stallTimer: null,
      ...(opts.onBytes ? { onBytes: opts.onBytes } : {}),
    };
    return this.client.enqueue(
      'dump',
      { from, limit },
      { timeoutMs: 5000, retry: false, ...(opts.signal ? { signal: opts.signal } : {}) },
      'lease',
      state,
    ) as Promise<DumpHeader>;
  }

  waitRxQuiet(quietMs: number, maxMs: number): Promise<boolean> {
    return this.client.waitRxQuiet(quietMs, maxMs);
  }

  resetDecoder(): void {
    this.client.resetDecoder();
  }

  closeLink(reason: string): void {
    if (!this.released) this.client.closeLink(reason);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.client.releaseLease(this);
  }
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Every firmware message starts with this (protocol_codec.c / protocol_events.c). */
const MESSAGE_START = '{"v":';

/**
 * Parse one received line. Binary bytes of an abandoned dump block that arrive late are
 * split into lines too, and the last of them sticks to the front of the next message; in
 * that case the message is read from its `{"v":` start, so the reply is not lost.
 */
function parseLine(line: string): Record<string, unknown> | null {
  const text = line.trim();
  const msg = text.startsWith('{') ? parseObject(text) : null;
  if (msg) return msg;
  const at = text.indexOf(MESSAGE_START, 1);
  return at > 0 ? parseObject(text.slice(at)) : null;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

const SMP_KEYS = ['t', 'h', 'g', 'v', 'vv', 'l', 'c'] as const;
const CATEGORY_IDS: ReadonlySet<string> = new Set(['g', 'v', 'l']);

function sanitizeSmp(data: Record<string, unknown>): SmpData {
  const out: SmpData = {};
  for (const k of SMP_KEYS) {
    if (!(k in data)) continue;
    const v = data[k];
    out[k] = typeof v === 'number' && Number.isFinite(v) ? v : null;
  }
  for (const k of ['wu', 'dc'] as const) {
    const arr = data[k];
    if (Array.isArray(arr)) {
      const ids = arr.filter((x): x is SensorCategoryId => typeof x === 'string' && CATEGORY_IDS.has(x));
      if (ids.length) out[k] = ids;
    }
  }
  return out;
}
