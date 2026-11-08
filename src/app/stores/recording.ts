import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef, watch } from 'vue';
import {
  deleteSession as dbDeleteSession,
  finishDeletions,
  type Db,
  type SessionRecord,
} from '../../core/data/db';
import { Recorder } from '../../core/data/recorder';
import type { Transports } from '../../core/protocol/types';
import { ownsDeviceWork } from '../composables/useAppStatus';
import { getDb } from '../db';
import { useDevicesStore, type DeviceEntry } from './devices';
import { useSettingsStore } from './settings';

export interface StorageInfo {
  usage: number;
  quota: number;
  persisted: boolean;
}

export const useRecordingStore = defineStore('recording', () => {
  const devices = useDevicesStore();
  const settings = useSettingsStore();
  let db: Db | null = null;
  let recorder: Recorder | null = null;
  const ready = ref(false);
  /**
   * This tab may record (it holds the devices). In another tab the recording data is read-only:
   * a session still marked 'recording' there belongs to the tab that is writing it.
   */
  let owner = true;
  const active = shallowRef<SessionRecord | null>(null);
  const samples = ref(0);
  const error = ref<string | null>(null);
  const sessions = shallowRef<SessionRecord[]>([]);
  const interrupted = shallowRef<SessionRecord[]>([]);
  const storage = ref<StorageInfo | null>(null);
  const transports = shallowRef<Transports | null>(null);

  // App and DataView both call init() on mount (DataView first: children mount before parents),
  // so it runs once and every caller waits for the same run.
  let initRun: Promise<void> | null = null;
  function init(): Promise<void> {
    initRun ??= doInit().catch((err: unknown) => {
      initRun = null;
      throw err;
    });
    return initRun;
  }

  async function doInit(): Promise<void> {
    const d = await getDb();
    // Sessions left 'recording' by a closed or crashed page are marked interrupted, but only by
    // the tab that holds the devices: in a second tab, such a session is being recorded right now.
    owner = await ownsDeviceWork();
    db = d;
    recorder = markRaw(new Recorder(d, { appVersion: __APP_VERSION__ }));
    recorder.onStatus((s) => {
      active.value = s.session ? { ...s.session } : null;
      samples.value = s.samples;
      error.value = s.error;
    });
    if (owner) {
      interrupted.value = await Recorder.recoverInterrupted(d);
      // In the background: a long session takes a while, and it is no longer listed anyway.
      void finishDeletions(d)
        .then(() => estimate())
        .catch(() => undefined);
    }
    await refresh();
    await estimate();
    ready.value = true;
    // Best effort: flush when the page is being hidden or closed.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void recorder?.flush();
    });
    window.addEventListener('pagehide', () => void recorder?.flush());
  }

  async function refresh(): Promise<void> {
    if (!db) return;
    sessions.value = (await db.getAll('sessions'))
      .filter((s) => s.status !== 'deleting')
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async function estimate(): Promise<void> {
    if (!navigator.storage?.estimate) return;
    const e = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    storage.value = { usage: e.usage ?? 0, quota: e.quota ?? 0, persisted };
  }

  function member(e: DeviceEntry): boolean {
    const hw = e.state.value.meta.hardwareId;
    return !!hw && !!recorder?.isMember(hw);
  }

  /** Start (or keep) logging on a device with the session outputs. */
  async function ensureLogging(e: DeviceEntry, tr: Transports): Promise<void> {
    const s = e.state.value;
    if (s.logging && s.stream === 'flowing') return; // already streaming: leave its flash setting alone
    await e.controller.startLogging(tr);
  }

  function requireOwner(): void {
    if (!owner) throw new Error('another tab holds the loggers');
  }

  async function start(opts: { title: string; flash: boolean }): Promise<void> {
    await init();
    requireOwner();
    const tr: Transports = { zigbee: false, ble: true, flash: opts.flash, usb: false };
    const online = devices.entries.filter((e) => e.state.value.conn.state === 'online' && e.state.value.meta.hardwareId);
    if (online.length === 0) throw new Error('no connected logger');
    const results = await Promise.allSettled(online.map((e) => ensureLogging(e, tr)));
    const ok = online.filter((_e, i) => results[i]!.status === 'fulfilled');
    if (ok.length === 0) throw (results[0] as PromiseRejectedResult).reason;
    transports.value = tr;
    await recorder!.start({
      title: opts.title,
      conditions: { ...settings.conditions },
      transports: tr,
      devices: ok.map((e) => ({ controller: e.controller, colorIndex: e.colorIndex })),
    });
    try {
      await navigator.storage?.persist?.();
    } catch {
      // not granted: fine
    }
    await refresh();
    await estimate();
  }

  async function stop(opts: { stopDevices: boolean }): Promise<void> {
    if (!recorder?.active) return;
    const members = devices.entries.filter(member);
    await recorder.stop();
    transports.value = null;
    if (opts.stopDevices) {
      await Promise.allSettled(
        members.filter((e) => e.state.value.conn.state === 'online').map((e) => e.controller.stopLogging()),
      );
    }
    await refresh();
    await estimate();
  }

  async function resume(sessionId: string, flash = true): Promise<void> {
    await init();
    requireOwner();
    const tr: Transports = { zigbee: false, ble: true, flash, usb: false };
    const online = devices.entries.filter((e) => e.state.value.conn.state === 'online' && e.state.value.meta.hardwareId);
    await Promise.allSettled(online.map((e) => ensureLogging(e, tr)));
    transports.value = tr;
    await recorder!.resume(
      sessionId,
      online.map((e) => ({ controller: e.controller, colorIndex: e.colorIndex })),
      tr,
    );
    interrupted.value = interrupted.value.filter((s) => s.id !== sessionId);
    await refresh();
  }

  function dismissInterrupted(sessionId: string): void {
    interrupted.value = interrupted.value.filter((s) => s.id !== sessionId);
  }

  async function remove(sessionId: string): Promise<void> {
    if (!db || active.value?.id === sessionId) return;
    // Refused while it is being recorded: here, or in another tab (still 'recording' there).
    if (await dbDeleteSession(db, sessionId)) {
      interrupted.value = interrupted.value.filter((s) => s.id !== sessionId);
    }
    await refresh();
    await estimate();
  }

  // While recording: devices that come online join; a member whose BLE-only logging ended with
  // a dropped link is restarted with the session outputs.
  let syncing = false;
  async function syncDevices(): Promise<void> {
    if (syncing || !recorder?.active || !transports.value) return;
    syncing = true;
    try {
      for (const e of devices.entries) {
        const s = e.state.value;
        if (s.conn.state !== 'online' || !s.meta.hardwareId) continue;
        if (!member(e)) {
          await ensureLogging(e, transports.value);
          await recorder.join({ controller: e.controller, colorIndex: e.colorIndex }, transports.value);
        } else if (s.logging === false) {
          await e.controller.startLogging(transports.value);
          await recorder.logEvent('restart', s.meta.hardwareId, 'logging had stopped after a disconnect');
        }
      }
    } catch {
      // retried on the next state change
    } finally {
      syncing = false;
    }
  }
  watch(
    () => devices.entries.map((e) => `${e.key}:${e.state.value.conn.state}:${e.state.value.logging}`).join('|'),
    () => void syncDevices(),
  );

  return {
    ready,
    active,
    samples,
    error,
    sessions,
    interrupted,
    storage,
    init,
    refresh,
    estimate,
    start,
    stop,
    resume,
    dismissInterrupted,
    remove,
    member,
  };
});
