import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONDITIONS, type ComfortConditions } from '../../../src/core/comfort/comfort';
import { attachComfort, recomputeComfort } from '../../../src/core/comfort/engine';
import { DeviceController } from '../../../src/core/device/controller';
import { Mutex } from '../../../src/core/util/emitter';
import { FakeFirmwareLink } from '../../helpers/fake-firmware';

const ctrls: DeviceController[] = [];
afterEach(() => {
  for (const c of ctrls.splice(0)) c.dispose();
});

function controller(seriesCapacity?: number) {
  let fw!: FakeFirmwareLink;
  const ctrl = new DeviceController({
    key: 'dev1',
    gate: new Mutex(),
    clientOptions: { gapMs: 1, timeoutCooldownMs: 5 },
    ...(seriesCapacity ? { seriesCapacity } : {}),
    openLink: async () => {
      fw = new FakeFirmwareLink();
      fw.settings.velocity.enabled = true; // PMV needs the air speed
      return fw;
    },
  });
  ctrls.push(ctrl);
  return { ctrl, fw: () => fw };
}

function derived(ctrl: DeviceController) {
  const s = ctrl.series;
  const w = s.window(s.firstTs, s.lastTs + 1, ['pmv', 'mrt']);
  return { ts: Array.from(w.ts), pmv: Array.from(w.cols.pmv!), mrt: Array.from(w.cols.mrt!) };
}

const until = async (pred: () => boolean) => {
  for (let i = 0; i < 400 && !pred(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(pred()).toBe(true);
};

const SAMPLE = { t: 24, h: 50, g: 25, v: 0.1 };

describe('comfort engine', () => {
  it('leaves the newest chart point alone when a sample with an older timestamp is not charted', async () => {
    const { ctrl, fw } = controller();
    await ctrl.connect();
    const off = attachComfort(ctrl, () => DEFAULT_CONDITIONS);
    fw().emitEvent('smp', SAMPLE, 1_800_000_000);
    await until(() => ctrl.series.length === 1);
    const before = derived(ctrl);
    expect(Number.isFinite(before.pmv[0])).toBe(true);

    // the device clock went back: the sample is shown live but not added to the chart
    fw().emitEvent('smp', { t: 30, h: 70, g: 34, v: 0.1 }, 1_800_000_000 - 60);
    await until(() => ctrl.live.values.t.value === 30);
    expect(ctrl.series.length).toBe(1);
    expect(derived(ctrl)).toEqual(before);
    off();
  });

  it('replays every sample when a full ring buffer moves on during the recompute', async () => {
    const { ctrl } = controller(20_000);
    const s = ctrl.series;
    for (let i = 0; i < s.capacity; i++) s.append(i, SAMPLE);
    const firstNew = s.capacity;
    let next = firstNew;
    let running = true;
    // new samples arrive between the time slices (each one pushes the oldest out)
    const feed = () => {
      if (!running) return;
      s.append(next++, SAMPLE);
      setTimeout(feed, 0);
    };
    setTimeout(feed, 0);
    const warm: ComfortConditions = { ...DEFAULT_CONDITIONS, clo: 0.5 };
    expect(await recomputeComfort(ctrl, warm, undefined, 1)).toBe(true);
    running = false;
    expect(next - firstNew).toBeGreaterThan(0); // the buffer did move during the replay

    const d = derived(ctrl);
    const replayed = d.pmv.filter((_v, k) => d.ts[k]! < firstNew);
    expect(replayed.length).toBeGreaterThan(0);
    const expected = replayed[0]!;
    expect(Number.isFinite(expected)).toBe(true);
    expect(replayed.every((v) => v === expected)).toBe(true); // none skipped (NaN)
  });
});
