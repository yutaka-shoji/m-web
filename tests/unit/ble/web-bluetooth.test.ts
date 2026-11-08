import { describe, expect, it } from 'vitest';
import { DeviceNotInRangeError } from '../../../src/core/ble/transport';
import { canWatchAdvertisements, waitForAdvertisement, WebBluetoothTransport } from '../../../src/core/ble/web-bluetooth';

/** Minimal BluetoothDevice stand-in: only what the transport touches. */
function fakeDevice(gatt: Partial<BluetoothRemoteGATTServer>, extra: Record<string, unknown> = {}): BluetoothDevice {
  const target = new EventTarget();
  return Object.assign(target, { id: 'dev-1', name: 'MLogger_0001', gatt: { connected: false, disconnect() {}, ...gatt } }, extra) as unknown as BluetoothDevice;
}

describe('WebBluetoothTransport.open', () => {
  it('reports a device missing from the browser cache as DeviceNotInRangeError', async () => {
    const device = fakeDevice({
      connect: () => Promise.reject(new DOMException('Bluetooth Device is no longer in range.', 'NetworkError')),
    });
    const err = await new WebBluetoothTransport(device).open().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceNotInRangeError);
  });

  it('passes other connection errors through unchanged', async () => {
    const device = fakeDevice({
      connect: () => Promise.reject(new DOMException('Connection attempt failed.', 'NetworkError')),
    });
    const err = await new WebBluetoothTransport(device).open().catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(DeviceNotInRangeError);
    expect((err as DOMException).name).toBe('NetworkError');
  });

  it('gives up on service discovery that never completes', async () => {
    let disconnected = false;
    const gatt: Partial<BluetoothRemoteGATTServer> = {
      connected: true,
      disconnect: () => void (disconnected = true),
      getPrimaryService: () => new Promise<BluetoothRemoteGATTService>(() => {}),
    };
    gatt.connect = () => Promise.resolve(gatt as BluetoothRemoteGATTServer);
    const err = await new WebBluetoothTransport(fakeDevice(gatt), { discoveryTimeoutMs: 30 })
      .open()
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/timed out/);
    expect(disconnected).toBe(true);
  });
});

describe('waitForAdvertisement', () => {
  it('is unavailable without watchAdvertisements (Chrome without the experimental flag)', async () => {
    const device = fakeDevice({});
    expect(canWatchAdvertisements(device)).toBe(false);
    await expect(waitForAdvertisement(device, new AbortController().signal)).rejects.toThrow(/not available/);
  });

  it('resolves on the first advertisement and stops watching', async () => {
    let watchSignal: AbortSignal | undefined;
    const device = fakeDevice(
      {},
      {
        watchAdvertisements(opts: { signal?: AbortSignal }) {
          watchSignal = opts.signal;
          return Promise.resolve();
        },
      },
    );
    expect(canWatchAdvertisements(device)).toBe(true);
    const p = waitForAdvertisement(device, new AbortController().signal);
    await Promise.resolve();
    device.dispatchEvent(new Event('advertisementreceived'));
    await expect(p).resolves.toBeUndefined();
    expect(watchSignal?.aborted).toBe(true);
  });

  it('rejects and stops watching when aborted', async () => {
    let watchSignal: AbortSignal | undefined;
    const device = fakeDevice(
      {},
      {
        watchAdvertisements(opts: { signal?: AbortSignal }) {
          watchSignal = opts.signal;
          return Promise.resolve();
        },
      },
    );
    const ac = new AbortController();
    const p = waitForAdvertisement(device, ac.signal);
    ac.abort(new Error('stop'));
    await expect(p).rejects.toThrow('stop');
    expect(watchSignal?.aborted).toBe(true);
  });
});
