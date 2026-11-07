import { XBEE_REQUEST_CHAR_UUID, XBEE_RESPONSE_CHAR_UUID, XBEE_SERVICE_UUID } from './constants';
import { DeviceNotInRangeError, type ByteTransport, type CloseReason } from './transport';
import { Listeners, type Unsubscribe } from '../util/emitter';

export interface WebBluetoothTransportOptions {
  /** `gatt.connect()` never times out on macOS, so we impose one. */
  connectTimeoutMs?: number;
  /** Service discovery + enabling indications (can stall on a half-open link). */
  discoveryTimeoutMs?: number;
  /** Pause after enabling indications before the first write. */
  settleMs?: number;
}

/** ByteTransport over a Web Bluetooth BluetoothDevice. Create a new instance per connection. */
export class WebBluetoothTransport implements ByteTransport {
  private req: BluetoothRemoteGATTCharacteristic | null = null;
  private resp: BluetoothRemoteGATTCharacteristic | null = null;
  private readonly dataListeners = new Listeners<[Uint8Array]>();
  private readonly closeListeners = new Listeners<[CloseReason]>();
  private opened = false;
  private closed = false;
  private readonly opts: Required<WebBluetoothTransportOptions>;
  private readonly device: BluetoothDevice;

  constructor(device: BluetoothDevice, opts: WebBluetoothTransportOptions = {}) {
    this.device = device;
    this.opts = { connectTimeoutMs: 15_000, discoveryTimeoutMs: 10_000, settleMs: 150, ...opts };
  }

  get id(): string {
    return this.device.id;
  }

  get name(): string | undefined {
    return this.device.name ?? undefined;
  }

  get isOpen(): boolean {
    return this.opened && !this.closed && !!this.device.gatt?.connected;
  }

  async open(signal?: AbortSignal): Promise<void> {
    const gatt = this.device.gatt;
    if (!gatt) throw new Error('device has no GATT server');
    this.device.addEventListener('gattserverdisconnected', this.onDisconnected);
    try {
      let server: BluetoothRemoteGATTServer;
      try {
        server = await withTimeout(gatt.connect(), this.opts.connectTimeoutMs, signal, () => gatt.disconnect());
      } catch (err) {
        if (isNotInRange(err)) throw new DeviceNotInRangeError(err.message, { cause: err });
        throw err;
      }
      await withTimeout(this.discover(server), this.opts.discoveryTimeoutMs, signal, () => gatt.disconnect());
      if (this.opts.settleMs > 0) await new Promise((r) => setTimeout(r, this.opts.settleMs));
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      this.opened = true;
    } catch (err) {
      this.teardown();
      if (gatt.connected) gatt.disconnect();
      throw err;
    }
  }

  private async discover(server: BluetoothRemoteGATTServer): Promise<void> {
    const service = await server.getPrimaryService(XBEE_SERVICE_UUID);
    this.req = await service.getCharacteristic(XBEE_REQUEST_CHAR_UUID);
    this.resp = await service.getCharacteristic(XBEE_RESPONSE_CHAR_UUID);
    this.resp.addEventListener('characteristicvaluechanged', this.onValue);
    await this.resp.startNotifications();
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (!this.req || this.closed) throw new Error('transport not open');
    await this.req.writeValueWithResponse(chunk as BufferSource);
  }

  onData(cb: (bytes: Uint8Array) => void): Unsubscribe {
    return this.dataListeners.add(cb);
  }

  onClose(cb: (reason: CloseReason) => void): Unsubscribe {
    return this.closeListeners.add(cb);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    try {
      if (this.device.gatt?.connected) this.device.gatt.disconnect();
    } catch {
      // ignore
    }
    this.closeListeners.emit('local');
  }

  private readonly onValue = (ev: Event): void => {
    const dv = (ev.target as BluetoothRemoteGATTCharacteristic).value;
    if (!dv || this.closed) return;
    // Copy: some platforms reuse the underlying buffer for the next notification.
    this.dataListeners.emit(new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength)));
  };

  private readonly onDisconnected = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    this.closeListeners.emit('remote');
  };

  private teardown(): void {
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.resp?.removeEventListener('characteristicvaluechanged', this.onValue);
  }
}

/** Chrome's rejection when the device is missing from its device cache (DEVICE_NO_LONGER_IN_RANGE). */
function isNotInRange(err: unknown): err is DOMException {
  return err instanceof DOMException && err.name === 'NetworkError' && /no longer in range/i.test(err.message);
}

/**
 * True when the browser can report advertisements of an already permitted device. Chrome exposes
 * `watchAdvertisements()` only with chrome://flags/#enable-experimental-web-platform-features.
 */
export function canWatchAdvertisements(device: BluetoothDevice): boolean {
  return typeof (device as Partial<Pick<BluetoothDevice, 'watchAdvertisements'>>).watchAdvertisements === 'function';
}

/**
 * Resolves on the next advertisement from `device`. The scan behind it also puts the device back
 * into Chrome's device cache, so `gatt.connect()` finds it again. Rejects when `signal` aborts or
 * the browser refuses to watch (e.g. the page is hidden).
 */
export function waitForAdvertisement(device: BluetoothDevice, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (!canWatchAdvertisements(device)) return reject(new Error('watchAdvertisements is not available'));
    if (signal.aborted) return reject(signal.reason ?? new Error('aborted'));
    const watch = new AbortController();
    let done = false;
    const finish = (err?: unknown) => {
      if (done) return;
      done = true;
      device.removeEventListener('advertisementreceived', onAdvertisement);
      signal.removeEventListener('abort', onAbort);
      watch.abort(); // stop scanning for it
      if (err === undefined) resolve();
      else reject(err);
    };
    const onAdvertisement = () => finish();
    const onAbort = () => finish(signal.reason ?? new Error('aborted'));
    device.addEventListener('advertisementreceived', onAdvertisement);
    signal.addEventListener('abort', onAbort, { once: true });
    device.watchAdvertisements({ signal: watch.signal }).catch((e: unknown) => finish(e));
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, signal: AbortSignal | undefined, onTimeout: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      onTimeout();
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
