import { XBEE_REQUEST_CHAR_UUID, XBEE_RESPONSE_CHAR_UUID, XBEE_SERVICE_UUID } from './constants';
import type { ByteTransport, CloseReason } from './transport';
import { Listeners, type Unsubscribe } from '../util/emitter';

export interface WebBluetoothTransportOptions {
  /** `gatt.connect()` never times out on macOS, so we impose one. */
  connectTimeoutMs?: number;
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
    this.opts = { connectTimeoutMs: 15_000, settleMs: 150, ...opts };
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
      const server = await withTimeout(gatt.connect(), this.opts.connectTimeoutMs, signal, () => gatt.disconnect());
      const service = await server.getPrimaryService(XBEE_SERVICE_UUID);
      this.req = await service.getCharacteristic(XBEE_REQUEST_CHAR_UUID);
      this.resp = await service.getCharacteristic(XBEE_RESPONSE_CHAR_UUID);
      this.resp.addEventListener('characteristicvaluechanged', this.onValue);
      await this.resp.startNotifications();
      if (this.opts.settleMs > 0) await new Promise((r) => setTimeout(r, this.opts.settleMs));
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      this.opened = true;
    } catch (err) {
      this.teardown();
      if (gatt.connected) gatt.disconnect();
      throw err;
    }
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
