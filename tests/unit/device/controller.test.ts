import { afterEach, describe, expect, it } from 'vitest';
import { DeviceNotInRangeError } from '../../../src/core/ble/transport';
import { DeviceController, type DeviceState } from '../../../src/core/device/controller';
import { Mutex } from '../../../src/core/util/emitter';
import { FakeFirmwareLink } from '../../helpers/fake-firmware';

const ctrls: DeviceController[] = [];
afterEach(() => {
  for (const c of ctrls.splice(0)) c.dispose();
});

function until(pred: () => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error('timeout waiting for condition'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

/** A device whose firmware state survives reconnects, behind fresh links. */
function makeDevice(init: (fw: FakeFirmwareLink) => void = () => {}) {
  const links: FakeFirmwareLink[] = [];
  let logging = false;
  const ctrl = new DeviceController({
    key: 'dev1',
    gate: new Mutex(),
    clientOptions: { gapMs: 1, timeoutCooldownMs: 5 },
    helloTimeoutMs: 100,
    openLink: async () => {
      const fw = new FakeFirmwareLink();
      fw.logging = logging;
      init(fw);
      links.push(fw);
      return fw;
    },
  });
  ctrls.push(ctrl);
  const states: DeviceState['conn']['state'][] = [];
  ctrl.onState((s) => {
    if (states.at(-1) !== s.conn.state) states.push(s.conn.state);
  });
  return { ctrl, links, states, setLogging: (v: boolean) => (logging = v) };
}

describe('DeviceController', () => {
  it('connects, handshakes and reports device meta', async () => {
    const { ctrl, links, states } = makeDevice();
    await ctrl.connect();
    expect(ctrl.snapshot.conn.state).toBe('online');
    expect(ctrl.snapshot.meta).toMatchObject({ name: 'MLogger_0001', hardwareId: '3DF27622', firmware: '4.0.1' });
    expect(ctrl.snapshot.meta.battery?.voltage_mv).toBe(2702);
    expect(ctrl.snapshot.logging).toBe(false);
    expect(states).toEqual(['connecting', 'handshaking', 'online']);
    // idle device: clock set during the handshake
    expect(links[0]!.accepted.map((l) => JSON.parse(l).command)).toEqual([
      'hello',
      'set_time',
      'get_settings',
      'get_battery',
      'get_probe_info',
    ]);
  });

  it('never stops a device that is already logging, and does not touch its clock', async () => {
    const { ctrl, links, setLogging } = makeDevice();
    setLogging(true);
    await ctrl.connect();
    expect(ctrl.snapshot.logging).toBe(true);
    const cmds = links[0]!.accepted.map((l) => JSON.parse(l).command);
    expect(cmds).not.toContain('stop_logging');
    expect(cmds).not.toContain('set_time');
  });

  it('reconnects automatically after the link drops', async () => {
    const { ctrl, links } = makeDevice();
    await ctrl.connect();
    links[0]!.disconnect();
    expect(ctrl.snapshot.conn.state).toBe('reconnecting');
    await until(() => ctrl.snapshot.conn.state === 'online', 5000);
    expect(links).toHaveLength(2);
  });

  it('stays disconnected after a user disconnect', async () => {
    const { ctrl, links } = makeDevice();
    await ctrl.connect();
    ctrl.disconnect();
    expect(ctrl.snapshot.conn.state).toBe('idle');
    await new Promise((r) => setTimeout(r, 1500));
    expect(links).toHaveLength(1);
  });

  it('flags firmware that does not answer hello as incompatible (v3) and does not retry', async () => {
    const { ctrl, links } = makeDevice((fw) => (fw['opts'].dropNextLines = 99));
    await ctrl.connect();
    expect(ctrl.snapshot.conn).toMatchObject({ state: 'incompatible', incompatible: 'v3' });
    await new Promise((r) => setTimeout(r, 1300));
    expect(links).toHaveLength(1);
  });

  it('answers time_sync_request with set_time', async () => {
    const { ctrl, links } = makeDevice();
    await ctrl.connect();
    const fw = links[0]!;
    const before = fw.accepted.length;
    fw.emitEvent('time_sync_request', { window_s: 30, name: 'MLogger_0001' });
    await until(() => fw.accepted.length > before);
    expect(JSON.parse(fw.accepted.at(-1)!).command).toBe('set_time');
  });

  it('restarts with set_time when start_logging reports rtc_unset', async () => {
    const { ctrl, links, setLogging } = makeDevice();
    setLogging(true); // skip the handshake set_time so the RTC stays unset
    await ctrl.connect();
    const fw = links[0]!;
    fw.logging = false;
    await ctrl.startLive();
    const cmds = fw.accepted.map((l) => JSON.parse(l).command);
    expect(cmds.slice(-3)).toEqual(['start_logging', 'set_time', 'start_logging']);
    expect(ctrl.snapshot.logging).toBe(true);
  });

  describe('a device the browser lost track of (DeviceNotInRangeError)', () => {
    /** Connects once, then the browser "forgets" the device until `visible` is set again. */
    function makeLost(opts: { waitForPresence?: (signal: AbortSignal) => Promise<void>; reconnectGiveUpMs?: number } = {}) {
      let visible = true;
      let attempts = 0;
      const links: FakeFirmwareLink[] = [];
      const ctrl = new DeviceController({
        key: 'lost1',
        gate: new Mutex(),
        clientOptions: { gapMs: 1, timeoutCooldownMs: 5 },
        helloTimeoutMs: 100,
        ...opts,
        openLink: async () => {
          attempts += 1;
          if (!visible) throw new DeviceNotInRangeError('Bluetooth Device is no longer in range.');
          const fw = new FakeFirmwareLink();
          links.push(fw);
          return fw;
        },
      });
      ctrls.push(ctrl);
      return { ctrl, links, attempts: () => attempts, setVisible: (v: boolean) => (visible = v) };
    }

    it('is flagged after a drop and reconnects on retryNow() once visible again', async () => {
      const { ctrl, links, attempts, setVisible } = makeLost();
      await ctrl.connect();
      setVisible(false);
      links[0]!.disconnect();
      expect(ctrl.snapshot.conn).toMatchObject({ state: 'reconnecting', notInRange: false });
      await until(() => ctrl.snapshot.conn.notInRange, 3000); // first retry after ~1 s
      expect(ctrl.snapshot.conn.state).toBe('reconnecting');
      const before = attempts();
      setVisible(true); // e.g. the user opened the device chooser
      ctrl.retryNow();
      await until(() => ctrl.snapshot.conn.state === 'online', 1000); // well before the 2 s backoff
      expect(attempts()).toBe(before + 1);
      expect(ctrl.snapshot.conn.notInRange).toBe(false);
    });

    it('reconnects by itself when the browser reports the device again (waitForPresence)', async () => {
      let seen: (() => void) | null = null;
      let watches = 0;
      const { ctrl, links, setVisible } = makeLost({
        waitForPresence: (signal) =>
          new Promise<void>((resolve, reject) => {
            watches += 1;
            seen = resolve;
            signal.addEventListener('abort', () => reject(new Error('aborted')));
          }),
      });
      await ctrl.connect();
      setVisible(false);
      links[0]!.disconnect();
      await until(() => ctrl.snapshot.conn.notInRange, 3000);
      expect(watches).toBe(1);
      setVisible(true);
      seen!();
      await until(() => ctrl.snapshot.conn.state === 'online', 1000);
      expect(ctrl.snapshot.conn.notInRange).toBe(false);
    });

    it('keeps the flag after giving up, and retryNow() starts over', async () => {
      const { ctrl, links, setVisible } = makeLost({ reconnectGiveUpMs: 0 }); // give up at the first failed retry
      await ctrl.connect();
      setVisible(false);
      links[0]!.disconnect();
      await until(() => ctrl.snapshot.conn.state === 'failed', 3000);
      expect(ctrl.snapshot.conn.notInRange).toBe(true);
      setVisible(true);
      ctrl.retryNow();
      await until(() => ctrl.snapshot.conn.state === 'online', 1000);
    });
  });

  it('treats a hello timeout on a device that answered before as a link problem, not v3', async () => {
    let silent = false;
    const links: FakeFirmwareLink[] = [];
    const ctrl = new DeviceController({
      key: 'dev2',
      gate: new Mutex(),
      clientOptions: { gapMs: 1, timeoutCooldownMs: 5 },
      helloTimeoutMs: 100,
      openLink: async () => {
        const fw = new FakeFirmwareLink(silent ? { dropNextLines: 99 } : {});
        links.push(fw);
        return fw;
      },
    });
    ctrls.push(ctrl);
    await ctrl.connect();
    silent = true;
    links[0]!.disconnect();
    await until(() => links.length === 2 && ctrl.snapshot.conn.state === 'reconnecting' && ctrl.snapshot.conn.attempt === 2, 4000);
    expect(ctrl.snapshot.conn.incompatible).toBeNull();
    silent = false;
    ctrl.retryNow();
    await until(() => ctrl.snapshot.conn.state === 'online', 2000);
  });

  it('feeds smp samples into the live state and the series', async () => {
    const { ctrl, links } = makeDevice();
    await ctrl.connect();
    links[0]!.emitEvent('smp', { t: 23.45, h: 55.2, g: 24.1, wu: ['v'] }, 1_800_000_000);
    await until(() => ctrl.series.length === 1);
    expect(ctrl.live.values.t).toMatchObject({ value: 23.45, status: 'ok' });
    expect(ctrl.live.values.v.status).toBe('off'); // velocity disabled in fake settings
    expect(ctrl.snapshot.stream).toBe('flowing');
  });
});
