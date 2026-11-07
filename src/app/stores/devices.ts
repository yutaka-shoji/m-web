import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef, watch, type ShallowRef } from 'vue';
import { MLOGGER_SCAN_FILTERS, XBEE_SERVICE_UUID } from '../../core/ble/constants';
import { canWatchAdvertisements, WebBluetoothTransport, waitForAdvertisement } from '../../core/ble/web-bluetooth';
import { openXBeeLink } from '../../core/ble/xbee-link';
import { attachComfort, recomputeComfort } from '../../core/comfort/engine';
import { DeviceController, type DeviceState } from '../../core/device/controller';
import type { LiveState } from '../../core/device/live-tracker';
import { useSettingsStore } from './settings';

export const SERIES_COUNT = 8;
const KNOWN_KEY = 'm-web.known-devices';
const LOG_LINES = 3000;

interface KnownDevice {
  id: string;
  name: string | null;
}

function loadKnown(): KnownDevice[] {
  try {
    return JSON.parse(localStorage.getItem(KNOWN_KEY) ?? '[]') as KnownDevice[];
  } catch {
    return [];
  }
}

/** One device as seen by the UI. The controller and series stay non-reactive. */
export interface DeviceEntry {
  readonly key: string;
  readonly controller: DeviceController;
  /** Connection/meta state; replaced (not mutated) on change. */
  readonly state: ShallowRef<DeviceState>;
  /** Latest display values; replaced on every sample. */
  readonly live: ShallowRef<LiveState>;
  /** 0-based device colour slot (--series-N), fixed for the life of the entry. */
  readonly colorIndex: number;
  /** Demo devices only: drop the simulated radio link (to try reconnection). */
  readonly simulateDrop?: () => void;
  /** Recent protocol traffic (diagnostics), oldest first. Not reactive. */
  readonly traffic: string[];
  dispose(): void;
}

const ACTIVE = new Set(['connecting', 'handshaking', 'online', 'reconnecting']);

export const useDevicesStore = defineStore('devices', () => {
  const settings = useSettingsStore();
  const entries = shallowRef<readonly DeviceEntry[]>([]);
  const supported = typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  const bluetoothAvailable = ref<boolean | null>(null);
  /**
   * The browser reports advertisements of known devices (Chrome: experimental flag), so a logger it
   * lost track of reconnects by itself; otherwise the user has to open the chooser once.
   */
  const autoFind =
    supported &&
    typeof (globalThis as { BluetoothDevice?: { prototype: Partial<BluetoothDevice> } }).BluetoothDevice?.prototype
      .watchAdvertisements === 'function';

  async function checkAvailability(): Promise<void> {
    if (!supported) return;
    try {
      bluetoothAvailable.value = await navigator.bluetooth.getAvailability();
      navigator.bluetooth.addEventListener('availabilitychanged', (e) => {
        bluetoothAvailable.value = (e as Event & { value?: boolean }).value ?? null;
      });
    } catch {
      bluetoothAvailable.value = null;
    }
  }

  function nextColor(): number {
    const used = new Set(entries.value.map((e) => e.colorIndex));
    for (let i = 0; i < SERIES_COUNT; i++) if (!used.has(i)) return i;
    return entries.value.length % SERIES_COUNT;
  }

  function register(controller: DeviceController, simulateDrop?: () => void): DeviceEntry {
    const state = shallowRef(controller.snapshot);
    const live = shallowRef(controller.live);
    const traffic: string[] = [];
    const unsubs = [
      controller.onTraffic((tr) => {
        traffic.push(`${new Date(tr.at).toISOString()} ${tr.dir.toUpperCase()} ${tr.line}`);
        if (traffic.length > LOG_LINES) traffic.splice(0, traffic.length - LOG_LINES);
      }),
      controller.onState((s) => (state.value = s)),
      controller.onLive((l) => (live.value = l)),
      // derived MRT/PMV/PPD for the charts, computed once per sample
      attachComfort(controller, () => settings.conditions),
    ];
    const entry: DeviceEntry = markRaw({
      key: controller.key,
      controller: markRaw(controller),
      state,
      live,
      colorIndex: nextColor(),
      traffic: markRaw(traffic),
      ...(simulateDrop ? { simulateDrop } : {}),
      dispose() {
        for (const u of unsubs) u();
        controller.dispose();
      },
    });
    entries.value = [...entries.value, entry];
    return entry;
  }

  /** Create (or reuse) the controller for a permitted BluetoothDevice and connect it. */
  function adopt(device: BluetoothDevice): DeviceEntry {
    const existing = entries.value.find((e) => e.key === device.id);
    if (existing) {
      void existing.controller.connect();
      return existing;
    }
    const controller = new DeviceController({
      key: device.id,
      bleName: device.name ?? null,
      openLink: async (signal) => {
        const transport = new WebBluetoothTransport(device);
        await transport.open(signal);
        return openXBeeLink(transport);
      },
      ...(canWatchAdvertisements(device) ? { waitForPresence: (signal: AbortSignal) => waitForAdvertisement(device, signal) } : {}),
    });
    // Development builds only: drop the GATT link as if the logger went out of range.
    const entry = register(controller, import.meta.env.DEV ? () => device.gatt?.disconnect() : undefined);
    // Remember it for reconnecting after a reload (where getDevices() is available).
    controller.onState((s) => {
      if (s.conn.state !== 'online') return;
      const known = loadKnown().filter((k) => k.id !== device.id);
      known.push({ id: device.id, name: s.meta.name });
      try {
        localStorage.setItem(KNOWN_KEY, JSON.stringify(known.slice(-16)));
      } catch {
        // ignore
      }
    });
    void controller.connect();
    return entry;
  }

  /** Opens the browser's device chooser; returns null if the user cancels. */
  async function addBluetoothDevice(): Promise<DeviceEntry | null> {
    if (!supported) throw new Error('Web Bluetooth is not available');
    let device: BluetoothDevice;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: MLOGGER_SCAN_FILTERS,
        optionalServices: [XBEE_SERVICE_UUID],
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return null; // chooser cancelled
      throw err;
    }
    return adopt(device);
  }

  /**
   * Loggers the browser lost track of (conn.notInRange) can reconnect only after a scan has seen
   * them again. The device chooser runs that scan: whatever the user picks — or if they cancel —
   * every such logger is retried right away. Call from a user gesture (button click).
   */
  async function findLostDevices(): Promise<DeviceEntry | null> {
    try {
      return await addBluetoothDevice();
    } finally {
      for (const e of entries.value) if (!e.controller.demo && e.state.value.conn.notInRange) e.controller.retryNow();
    }
  }

  /** Devices this origin may still use and that were connected before (getDevices: Chrome flag). */
  const restorable = shallowRef<BluetoothDevice[]>([]);
  async function findRestorable(): Promise<void> {
    const bt = supported ? (navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> }) : null;
    if (!bt?.getDevices) return;
    try {
      const known = new Set(loadKnown().map((k) => k.id));
      const present = new Set(entries.value.map((e) => e.key));
      restorable.value = (await bt.getDevices()).filter((d) => known.has(d.id) && !present.has(d.id));
    } catch {
      restorable.value = [];
    }
  }
  function reconnectRestorable(): void {
    for (const d of restorable.value) adopt(d);
    restorable.value = [];
  }

  async function addDemoDevices(count = 3): Promise<void> {
    const { SimDevice, DEMO_PROFILES } = await import('../../core/sim/sim-device');
    const existing = new Set(entries.value.map((e) => e.key));
    for (const profile of DEMO_PROFILES.slice(0, count)) {
      const key = `demo:${profile.hardwareId}`;
      if (existing.has(key)) continue;
      const sim = new SimDevice(profile);
      let link: ReturnType<typeof sim.connect> | null = null;
      const controller = new DeviceController({
        key,
        demo: true,
        bleName: profile.name,
        openLink: async () => {
          await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
          link = sim.connect();
          return link;
        },
      });
      register(controller, () => link?.drop());
      void controller.connect();
    }
  }

  function remove(key: string): void {
    const entry = entries.value.find((e) => e.key === key);
    if (!entry) return;
    entry.dispose();
    entries.value = entries.value.filter((e) => e !== entry);
  }

  // When clo/met change, rewrite the derived channels of every in-memory series (time-sliced).
  let recompute: AbortController | null = null;
  watch(
    () => settings.conditionsVersion,
    async () => {
      recompute?.abort();
      const ac = new AbortController();
      recompute = ac;
      for (const e of entries.value) {
        if (!(await recomputeComfort(e.controller, settings.conditions, ac.signal))) return;
      }
    },
  );

  const connectedCount = computed(() => entries.value.filter((e) => e.state.value.conn.state === 'online').length);
  /** Loggers waiting for a scan before they can reconnect. */
  const lostCount = computed(
    () =>
      entries.value.filter((e) => {
        const c = e.state.value.conn;
        return c.notInRange && (c.state === 'reconnecting' || c.state === 'connecting' || c.state === 'failed');
      }).length,
  );
  /** True while any device is connected or trying to be (used by the unload guard). */
  const anyActive = computed(() => entries.value.some((e) => ACTIVE.has(e.state.value.conn.state)));

  return {
    entries,
    supported,
    bluetoothAvailable,
    checkAvailability,
    addBluetoothDevice,
    findLostDevices,
    autoFind,
    lostCount,
    restorable,
    findRestorable,
    reconnectRestorable,
    addDemoDevices,
    remove,
    connectedCount,
    anyActive,
  };
});
