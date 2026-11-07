/**
 * One M-Logger: connection state machine, handshake, live data and commands.
 *
 *   idle → connecting → handshaking → online
 *                ↘ (error / drop) → reconnecting → connecting …
 *   hello timeout → incompatible('v3'); hello from something else → incompatible('not_mlogger')
 *
 * - Connect/unlock runs through a shared gate (one device at a time).
 * - A device that is already logging is never stopped automatically (unlike the phone app).
 * - Automatic reconnect with backoff; unlimited while `keepAlive` is set (recording / download).
 * - A device the browser has lost track of (`conn.notInRange`, see DeviceNotInRangeError) only
 *   becomes connectable again after a scan: `waitForPresence` (where supported) or a device
 *   chooser opened by the user, followed by `retryNow()`.
 * - The clock is set on connect only when the device is idle; while logging it is corrected on
 *   the firmware's own `time_sync_request`.
 */
import { DeviceNotInRangeError } from '../ble/transport';
import type { PayloadLink } from '../ble/xbee-link';
import { MLoggerClient, type CallOptions, type ClientOptions } from '../protocol/client';
import type { CommandName, ParamsOf, ResultOf } from '../protocol/commands';
import { CommandTimeoutError, ProtocolError } from '../protocol/errors';
import type {
  BatteryResult,
  Co2CalibrationProgress,
  ProbeInfo,
  Settings,
  SettingsPatch,
  SmpEvent,
  Transports,
} from '../protocol/types';
import { DeviceSeries } from '../data/series';
import { Listeners, Mutex, type Unsubscribe } from '../util/emitter';
import { LiveTracker, type LiveState } from './live-tracker';

export type ConnState = 'idle' | 'connecting' | 'handshaking' | 'online' | 'reconnecting' | 'incompatible' | 'failed';
export type StreamState = 'unknown' | 'flowing' | 'silent' | 'scheduled';

export interface ConnInfo {
  readonly state: ConnState;
  readonly attempt: number;
  readonly nextRetryAt: number | null;
  readonly error: string | null;
  readonly incompatible: 'v3' | 'not_mlogger' | null;
  /** The browser no longer sees the device: it must be found by a scan before it can reconnect. */
  readonly notInRange: boolean;
}

export interface DeviceMeta {
  readonly name: string | null;
  readonly hardwareId: string | null;
  readonly firmware: string | null;
  readonly battery: BatteryResult | null;
  readonly batteryAt: number;
  readonly settings: Settings | null;
  readonly probes: ProbeInfo | null;
}

export interface DeviceState {
  readonly key: string;
  readonly demo: boolean;
  readonly bleName: string | null;
  readonly conn: ConnInfo;
  readonly meta: DeviceMeta;
  /** null until known (hello). */
  readonly logging: boolean | null;
  readonly transports: Transports | null;
  readonly stream: StreamState;
  readonly op: 'dump' | 'co2cal' | null;
}

export type LinkOpener = (signal: AbortSignal) => Promise<PayloadLink>;

export interface DeviceControllerOptions {
  key: string;
  openLink: LinkOpener;
  demo?: boolean;
  bleName?: string | null;
  gate?: Mutex;
  clientOptions?: ClientOptions;
  seriesCapacity?: number;
  now?: () => number;
  /** Give up reconnecting after this long unless keepAlive is set. */
  reconnectGiveUpMs?: number;
  batteryPollMs?: number;
  /** Override the hello timeout (tests). */
  helloTimeoutMs?: number;
  /**
   * Resolves when the device is seen advertising again. Given only where the browser can watch
   * advertisements; lets a device the browser lost track of reconnect without user interaction.
   */
  waitForPresence?: (signal: AbortSignal) => Promise<void>;
}

export class IncompatibleDeviceError extends Error {
  readonly kind: 'v3' | 'not_mlogger';

  constructor(kind: 'v3' | 'not_mlogger') {
    super(kind === 'v3' ? 'no v4 response (firmware v3?)' : 'not an M-Logger');
    this.name = 'IncompatibleDeviceError';
    this.kind = kind;
  }
}

const RECONNECT_DELAYS_S = [1, 2, 5, 10, 20, 30];
const sharedGate = new Mutex();

export class DeviceController {
  readonly key: string;
  readonly demo: boolean;
  readonly series: DeviceSeries;
  private readonly openLink: LinkOpener;
  private readonly gate: Mutex;
  private readonly clientOptions: ClientOptions;
  private readonly now: () => number;
  private readonly giveUpMs: number;
  private readonly batteryPollMs: number;
  private readonly helloTimeoutMs: number | undefined;
  private readonly waitForPresence: ((signal: AbortSignal) => Promise<void>) | undefined;
  private presenceWatch: AbortController | null = null;
  /** Answered a v4 `hello` before: a later hello timeout is a link problem, not old firmware. */
  private provenV4 = false;
  private readonly tracker = new LiveTracker();
  private readonly stateL = new Listeners<[DeviceState]>();
  private readonly liveL = new Listeners<[LiveState]>();
  private readonly sampleL = new Listeners<[SmpEvent]>();
  private readonly lineL = new Listeners<[{ dir: 'tx' | 'rx'; line: string; at: number }]>();
  private readonly co2L = new Listeners<[Co2CalibrationProgress]>();
  private state: DeviceState;
  private client: MLoggerClient | null = null;
  private link: PayloadLink | null = null;
  private abort: AbortController | null = null;
  private wantConnected = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectSince = 0;
  private batteryTimer: ReturnType<typeof setInterval> | null = null;
  private streamTimer: ReturnType<typeof setTimeout> | null = null;
  /** Keep reconnecting without giving up (recording session or download in progress). */
  keepAlive = false;

  constructor(opts: DeviceControllerOptions) {
    this.key = opts.key;
    this.demo = opts.demo ?? false;
    this.openLink = opts.openLink;
    this.gate = opts.gate ?? sharedGate;
    this.clientOptions = opts.clientOptions ?? {};
    this.now = opts.now ?? (() => Date.now());
    this.giveUpMs = opts.reconnectGiveUpMs ?? 10 * 60_000;
    this.batteryPollMs = opts.batteryPollMs ?? 10 * 60_000;
    this.helloTimeoutMs = opts.helloTimeoutMs;
    this.waitForPresence = opts.waitForPresence;
    this.series = new DeviceSeries(opts.seriesCapacity);
    const initial: DeviceState = {
      key: opts.key,
      demo: this.demo,
      bleName: opts.bleName ?? null,
      conn: { state: 'idle', attempt: 0, nextRetryAt: null, error: null, incompatible: null, notInRange: false },
      meta: { name: null, hardwareId: null, firmware: null, battery: null, batteryAt: 0, settings: null, probes: null },
      logging: null,
      transports: null,
      stream: 'unknown',
      op: null,
    };
    this.state = Object.freeze(initial);
  }

  // ---------------------------------------------------------------- observation

  get snapshot(): DeviceState {
    return this.state;
  }

  get live(): LiveState {
    return this.tracker.current;
  }

  get online(): boolean {
    return this.state.conn.state === 'online';
  }

  /** Connection/meta changes (not per sample). */
  onState(cb: (s: DeviceState) => void): Unsubscribe {
    return this.stateL.add(cb);
  }

  /** Display state after each sample. */
  onLive(cb: (l: LiveState) => void): Unsubscribe {
    return this.liveL.add(cb);
  }

  /** Every raw sample (for the recorder). */
  onSample(cb: (e: SmpEvent) => void): Unsubscribe {
    return this.sampleL.add(cb);
  }

  /** CO2 calibration progress events. */
  onCo2(cb: (p: Co2CalibrationProgress) => void): Unsubscribe {
    return this.co2L.add(cb);
  }

  /** Raw protocol lines (diagnostics log). */
  onTraffic(cb: (t: { dir: 'tx' | 'rx'; line: string; at: number }) => void): Unsubscribe {
    return this.lineL.add(cb);
  }

  private patch(p: Partial<Omit<DeviceState, 'conn' | 'meta'>> & { conn?: Partial<ConnInfo>; meta?: Partial<DeviceMeta> }): void {
    const s = this.state;
    this.state = Object.freeze({
      ...s,
      ...p,
      conn: p.conn ? Object.freeze({ ...s.conn, ...p.conn }) : s.conn,
      meta: p.meta ? Object.freeze({ ...s.meta, ...p.meta }) : s.meta,
    });
    this.stateL.emit(this.state);
  }

  // ---------------------------------------------------------------- connection

  /** User intent: connect and stay connected (reconnect automatically). */
  connect(): Promise<void> {
    this.wantConnected = true;
    this.reconnectSince = 0;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    return this.runConnect(0);
  }

  /** User intent: disconnect and stop reconnecting. */
  disconnect(): void {
    this.wantConnected = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopPresenceWatch();
    this.abort?.abort();
    this.teardown('closed by user');
    this.patch({
      conn: { state: 'idle', attempt: 0, nextRetryAt: null, error: null, notInRange: false },
      stream: 'unknown',
    });
  }

  /**
   * Try again now instead of waiting for the backoff timer (or after giving up) — e.g. right after
   * the device chooser has scanned, which makes a device the browser had lost track of
   * connectable again. Does nothing while connected, connecting, or disconnected by the user.
   */
  retryNow(): void {
    if (this.state.conn.state === 'failed') {
      void this.connect();
      return;
    }
    if (!this.wantConnected || this.client || this.connecting) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    void this.runConnect(Math.max(1, this.state.conn.attempt));
  }

  private async runConnect(attempt: number): Promise<void> {
    if (this.connecting || this.client) return;
    this.connecting = true;
    const ac = new AbortController();
    this.abort = ac;
    this.patch({
      conn: { state: attempt > 0 ? 'reconnecting' : 'connecting', attempt, nextRetryAt: null, incompatible: null },
    });
    try {
      await this.gate.run(async () => {
        if (ac.signal.aborted) throw new Error('aborted');
        this.patch({ conn: { state: 'connecting' } });
        const link = await this.openLink(ac.signal);
        if (ac.signal.aborted) {
          link.close('aborted');
          throw new Error('aborted');
        }
        this.attach(link);
      });
      this.patch({ conn: { state: 'handshaking' } });
      await this.handshake();
      this.reconnectSince = 0;
      this.stopPresenceWatch();
      this.patch({ conn: { state: 'online', attempt: 0, error: null, nextRetryAt: null, notInRange: false } });
      this.startBatteryPoll();
    } catch (err) {
      this.teardown('connect failed');
      if (err instanceof IncompatibleDeviceError) {
        this.wantConnected = false;
        this.patch({ conn: { state: 'incompatible', incompatible: err.kind, error: err.message, notInRange: false } });
      } else if (this.wantConnected && !ac.signal.aborted) {
        this.scheduleReconnect(err, attempt + 1);
      } else if (!this.wantConnected) {
        this.patch({ conn: { state: 'idle' } });
      }
    } finally {
      this.connecting = false;
      if (this.abort === ac) this.abort = null;
    }
  }

  private attach(link: PayloadLink): void {
    const client = new MLoggerClient(link, this.clientOptions);
    this.link = link;
    this.client = client;
    client.on('smp', (e) => this.onSmp(e));
    client.on('ready', (e) => {
      if (typeof e.logging === 'boolean' && e.logging !== this.state.logging) this.patch({ logging: e.logging });
    });
    client.on('time_sync_request', () => {
      void client.call('set_time', { ts: Math.floor(this.now() / 1000) }, { priority: 'urgent' }).catch(() => {});
    });
    client.on('traffic', (t) => this.lineL.emit(t));
    client.on('co2_calibration_progress', (p) => {
      this.co2L.emit(p);
      if (p.state !== 'measuring' && this.state.op === 'co2cal') this.patch({ op: null });
    });
    link.onClose((err) => {
      if (this.link !== link) return;
      this.teardown(err.message);
      if (this.wantConnected) this.scheduleReconnect(err, 1);
      else this.patch({ conn: { state: 'idle' }, stream: 'unknown' });
    });
  }

  private teardown(reason: string): void {
    this.stopTimers();
    const link = this.link;
    this.link = null;
    this.client?.dispose(new Error(reason));
    this.client = null;
    if (link && !link.closed) link.close(reason);
  }

  private stopTimers(): void {
    if (this.batteryTimer) clearInterval(this.batteryTimer);
    this.batteryTimer = null;
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = null;
  }

  private scheduleReconnect(err: unknown, attempt: number): void {
    const now = this.now();
    if (!this.reconnectSince) this.reconnectSince = now;
    const message = err instanceof Error ? err.message : String(err);
    const notInRange = err instanceof DeviceNotInRangeError;
    if (!this.keepAlive && now - this.reconnectSince > this.giveUpMs) {
      this.wantConnected = false;
      this.stopPresenceWatch();
      this.patch({ conn: { state: 'failed', error: message, nextRetryAt: null, notInRange }, stream: 'unknown' });
      return;
    }
    if (notInRange) this.watchPresence();
    const base = RECONNECT_DELAYS_S[Math.min(attempt - 1, RECONNECT_DELAYS_S.length - 1)]!;
    const delayS = attempt > RECONNECT_DELAYS_S.length ? 60 : base;
    const delayMs = delayS * 1000 * (0.8 + 0.4 * Math.random());
    this.patch({
      conn: { state: 'reconnecting', attempt, nextRetryAt: now + delayMs, error: message, notInRange },
      stream: 'unknown',
    });
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.wantConnected) void this.runConnect(attempt);
    }, delayMs);
  }

  /** Reconnect as soon as the browser sees the device advertising (where it can tell). */
  private watchPresence(): void {
    if (!this.waitForPresence || this.presenceWatch) return;
    const ac = new AbortController();
    this.presenceWatch = ac;
    this.waitForPresence(ac.signal).then(
      () => {
        if (this.presenceWatch !== ac) return;
        this.presenceWatch = null;
        this.retryNow();
      },
      () => {
        // aborted or refused (e.g. hidden page): the next failed attempt starts a new watch
        if (this.presenceWatch === ac) this.presenceWatch = null;
      },
    );
  }

  private stopPresenceWatch(): void {
    this.presenceWatch?.abort();
    this.presenceWatch = null;
  }

  private async handshake(): Promise<void> {
    const c = this.client!;
    let hello: ResultOf<'hello'>;
    try {
      hello = await c.call('hello', undefined, this.helloTimeoutMs ? { timeoutMs: this.helloTimeoutMs } : {});
    } catch (err) {
      // Silence from a device that has answered before is a link problem, not old firmware.
      if (err instanceof CommandTimeoutError && !this.provenV4) throw new IncompatibleDeviceError('v3');
      throw err;
    }
    if (hello.device !== 'M-Logger' || !(hello.protocol_version >= 1)) throw new IncompatibleDeviceError('not_mlogger');
    this.provenV4 = true;
    this.patch({
      meta: { name: hello.name, hardwareId: hello.hardware_id, firmware: hello.firmware_version },
      logging: hello.logging,
    });
    if (!hello.logging) await c.call('set_time', { ts: Math.floor(this.now() / 1000) });
    const settings = await c.call('get_settings', undefined);
    this.tracker.setSettings(settings);
    this.liveL.emit(this.tracker.current);
    const battery = await c.call('get_battery', undefined);
    this.patch({ meta: { settings, battery, batteryAt: this.now() } });
    try {
      const probes = await c.call('get_probe_info', undefined);
      this.patch({ meta: { probes } });
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err; // older firmware: unknown_command
    }
    if (hello.logging) this.watchStream(settings);
  }

  private startBatteryPoll(): void {
    if (this.batteryTimer) clearInterval(this.batteryTimer);
    this.batteryTimer = setInterval(() => {
      void this.client
        ?.call('get_battery', undefined, { priority: 'background' })
        .then((battery) => this.patch({ meta: { battery, batteryAt: this.now() } }))
        .catch(() => {});
    }, this.batteryPollMs);
  }

  /** After a logging start/restart: decide whether samples are flowing over BLE. */
  private watchStream(settings: Settings): void {
    if (this.streamTimer) clearTimeout(this.streamTimer);
    const nowS = this.now() / 1000;
    if (settings.start_ts > nowS + 2) {
      this.patch({ stream: 'scheduled' });
      return;
    }
    const intervals = (['general', 'velocity', 'illuminance'] as const)
      .filter((k) => settings[k].enabled)
      .map((k) => settings[k].interval);
    const shortest = intervals.length ? Math.min(...intervals) : 60;
    const waitMs = Math.min(1.5 * shortest + 10, 180) * 1000 + 25_000; // + TH probe warm-up
    this.patch({ stream: 'unknown' });
    this.streamTimer = setTimeout(() => {
      this.streamTimer = null;
      if (this.state.stream !== 'flowing') this.patch({ stream: 'silent' });
    }, waitMs);
  }

  private onSmp(e: SmpEvent): void {
    if (this.state.stream !== 'flowing' || this.state.logging !== true) this.patch({ stream: 'flowing', logging: true });
    this.series.append(e.ts, e.data);
    this.liveL.emit(this.tracker.apply(e.ts, e.data, e.receivedAt));
    this.sampleL.emit(e);
  }

  // ---------------------------------------------------------------- commands

  private requireClient(): MLoggerClient {
    if (!this.client || this.state.conn.state !== 'online') throw new Error('device is not connected');
    return this.client;
  }

  /** Generic command passthrough (drawer actions). */
  call<K extends CommandName>(command: K, params: ParamsOf<K>, opts?: CallOptions): Promise<ResultOf<K>> {
    return this.requireClient().call(command, params, opts);
  }

  get protocolClient(): MLoggerClient | null {
    return this.client;
  }

  /** Link statistics of the current connection (diagnostics). */
  get linkStats(): Readonly<{ unlockMs: number; rxBytes: number; txBytes: number }> | null {
    return this.link ? this.link.stats : null;
  }

  async refreshSettings(): Promise<Settings> {
    const settings = await this.requireClient().call('get_settings', undefined);
    this.tracker.setSettings(settings);
    this.liveL.emit(this.tracker.current);
    this.patch({ meta: { settings } });
    return settings;
  }

  /** Start logging with the given outputs (restarts if already logging). */
  async startLogging(transports: Transports): Promise<void> {
    const c = this.requireClient();
    const params = { transports, mode: 'once' as const };
    try {
      await c.call('start_logging', params);
    } catch (err) {
      if (!(err instanceof ProtocolError && err.code === 'rtc_unset')) throw err;
      await c.call('set_time', { ts: Math.floor(this.now() / 1000) });
      await c.call('start_logging', params);
    }
    this.tracker.reset();
    this.liveL.emit(this.tracker.current);
    this.patch({ logging: true, transports });
    if (transports.ble && this.state.meta.settings) this.watchStream(this.state.meta.settings);
  }

  /** Live view: BLE-only logging (stops by itself if the connection drops). */
  startLive(): Promise<void> {
    return this.startLogging({ zigbee: false, ble: true, flash: false, usb: false });
  }

  async stopLogging(): Promise<void> {
    await this.requireClient().call('stop_logging', undefined, { priority: 'urgent' });
    if (this.streamTimer) clearTimeout(this.streamTimer);
    this.streamTimer = null;
    this.patch({ logging: false, stream: 'unknown' });
  }

  async setSettings(patch: SettingsPatch): Promise<Settings> {
    const settings = await this.requireClient().call('set_settings', patch);
    this.tracker.setSettings(settings);
    this.liveL.emit(this.tracker.current);
    this.patch({ meta: { settings } });
    return settings;
  }

  async refreshBattery(): Promise<void> {
    const battery = await this.requireClient().call('get_battery', undefined);
    this.patch({ meta: { battery, batteryAt: this.now() } });
  }

  async rename(name: string): Promise<void> {
    const res = await this.requireClient().call('set_name', { name });
    this.patch({ meta: { name: res.name } });
  }

  setOp(op: DeviceState['op']): void {
    this.patch({ op });
  }

  /** Permanently drop this controller. */
  dispose(): void {
    this.disconnect();
    this.stateL.clear();
    this.liveL.clear();
    this.sampleL.clear();
    this.lineL.clear();
    this.co2L.clear();
  }
}
