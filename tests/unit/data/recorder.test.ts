import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS } from '../../../src/core/comfort/comfort';
import { meanRadiantTemperature } from '../../../src/core/comfort/mrt';
import { pmvPpd } from '../../../src/core/comfort/pmv';
import { openMWebDB, type Db } from '../../../src/core/data/db';
import { Recorder } from '../../../src/core/data/recorder';
import { DeviceController } from '../../../src/core/device/controller';
import { exportSessionCsv } from '../../../src/core/export/export-session';
import { Mutex } from '../../../src/core/util/emitter';
import { FakeFirmwareLink } from '../../helpers/fake-firmware';

const TRANSPORTS = { zigbee: false, ble: true, flash: true, usb: false };
let dbCount = 0;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function setup() {
  const db: Db = await openMWebDB(`test-${++dbCount}`);
  let fw!: FakeFirmwareLink;
  const ctrl = new DeviceController({
    key: 'k1',
    gate: new Mutex(),
    clientOptions: { gapMs: 1 },
    openLink: async () => {
      fw = new FakeFirmwareLink();
      fw.settings.velocity.enabled = true;
      fw.settings.velocity.interval = 5;
      return fw;
    },
  });
  await ctrl.connect();
  cleanups.push(() => ctrl.dispose());
  const rec = new Recorder(db, { flushMs: 0, appVersion: 'test' });
  return { db, ctrl, fw: () => fw, rec };
}

const settle = () => new Promise((r) => setTimeout(r, 30));

describe('Recorder + CSV export', () => {
  it('stores samples in chunks and exports them with recomputed comfort indices', async () => {
    const { db, ctrl, fw, rec } = await setup();
    const session = await rec.start({
      title: '会議室A 計測',
      conditions: DEFAULT_CONDITIONS,
      transports: TRANSPORTS,
      devices: [{ controller: ctrl, colorIndex: 0 }],
    });
    const t0 = 1_794_042_000; // 2026-11-07 18:00:00 JST
    fw().emitEvent('smp', { t: 23.45, h: 55.2, g: 24.1, v: 0.12, vv: 2350, l: 420, c: 425 }, t0);
    fw().emitEvent('smp', { l: 421 }, t0 + 5);
    fw().emitEvent('smp', { g: 24.2, wu: ['g'] }, t0 + 10);
    await settle();
    const stopped = await rec.stop();
    expect(stopped?.status).toBe('stopped');
    expect(stopped?.samples).toBe(3);
    expect((await db.getAll('chunks')).length).toBeGreaterThanOrEqual(1);

    const [file] = await exportSessionCsv(db, (await db.get('sessions', session.id))!, {
      conditions: DEFAULT_CONDITIONS,
      voltage: true,
      layout: 'per-device',
    });
    const text = file!.parts.join('');
    const lines = text.split('\r\n');
    expect(lines[0]).toBe(
      '﻿datetime,unix_time,t_dry[C],rh[%],t_glb[C],velocity[m/s],illuminance[lx],co2[ppm],mrt[C],pmv,ppd[%],velocity_voltage[mV]',
    );
    const mrt = meanRadiantTemperature(23.45, 24.1, 0.12);
    const { pmv, ppd } = pmvPpd({ ta: 23.45, tr: mrt, vr: 0.12, rh: 55.2, met: 1.1, clo: 1.0 });
    expect(lines[1]).toBe(
      `2026-11-07 18:00:00,${t0},23.45,55.2,24.10,0.120,420,425,${mrt.toFixed(2)},${pmv.toFixed(3)},${ppd.toFixed(1)},2350`,
    );
    // illuminance-only sample: derived values carried forward from the previous state
    expect(lines[2]).toBe(`2026-11-07 18:00:05,${t0 + 5},,,,,421,,${mrt.toFixed(2)},${pmv.toFixed(3)},${ppd.toFixed(1)},`);
    // TH probe warming up: globe value present, derived indices withheld (official app rule)
    expect(lines[3]).toBe(`2026-11-07 18:00:10,${t0 + 10},,,24.20,,,,,,,`);
    expect(file!.name).toBe('会議室A_計測_MLogger_0001_3DF27622.csv');
  });

  it('marks an unfinished session as interrupted and resumes it without losing chunks', async () => {
    const { db, ctrl, fw, rec } = await setup();
    const s = await rec.start({ title: 'x', conditions: DEFAULT_CONDITIONS, transports: TRANSPORTS, devices: [{ controller: ctrl, colorIndex: 0 }] });
    fw().emitEvent('smp', { t: 20 }, 1_800_000_000);
    await settle();
    await rec.flush();
    // simulate a reload: a fresh recorder on the same database
    const interrupted = await Recorder.recoverInterrupted(db);
    expect(interrupted.map((x) => x.id)).toEqual([s.id]);
    expect((await db.get('sessions', s.id))!.status).toBe('interrupted');

    const rec2 = new Recorder(db, { flushMs: 0 });
    await rec2.resume(s.id, [{ controller: ctrl, colorIndex: 0 }], TRANSPORTS);
    fw().emitEvent('smp', { t: 21 }, 1_800_000_005);
    await settle();
    await rec2.stop();
    const chunks = await db.getAll('chunks');
    expect(chunks.map((c) => c.seq).sort()).toEqual([0, 1]);
    const [file] = await exportSessionCsv(db, (await db.get('sessions', s.id))!, {
      conditions: DEFAULT_CONDITIONS,
      voltage: false,
      layout: 'long',
    });
    const lines = file!.parts.join('').trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]!.startsWith('MLogger_0001,3DF27622,')).toBe(true);
  });
});
