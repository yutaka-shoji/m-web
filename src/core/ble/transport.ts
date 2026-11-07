import type { Unsubscribe } from '../util/emitter';

export type CloseReason = 'remote' | 'local';

/**
 * The browser no longer knows the device, so a connection is not even attempted. Chrome on macOS
 * forgets a device that is not connected and has not been seen advertising for about three
 * minutes — i.e. right after a link drops that was up for longer than that. Something has to scan
 * and see the device again (the device chooser, or `watchAdvertisements()`) before it can connect.
 */
export class DeviceNotInRangeError extends Error {
  constructor(message = 'device not in range', options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeviceNotInRangeError';
  }
}

/**
 * One GATT connection to an XBee API service, reduced to an ordered byte pipe.
 * Implemented by WebBluetoothTransport (browser, or Node via the `webbluetooth` package)
 * and by test doubles.
 */
export interface ByteTransport {
  /** Stable id of the underlying device for this origin (BluetoothDevice.id). */
  readonly id: string;
  readonly name: string | undefined;
  readonly isOpen: boolean;
  /** Connect, discover the service and enable indications. */
  open(signal?: AbortSignal): Promise<void>;
  /** Exactly one GATT write (with response). Rejects on any GATT error. */
  write(chunk: Uint8Array): Promise<void>;
  /** Indication payloads, in arrival order. The array is owned by the callee. */
  onData(cb: (bytes: Uint8Array) => void): Unsubscribe;
  onClose(cb: (reason: CloseReason) => void): Unsubscribe;
  close(): void;
}
