/**
 * Keeps the derived comfort channels (mrt/pmv/ppd) of a device's in-memory series up to date:
 * one evaluation per incoming sample from the forward-filled display state, and a full,
 * time-sliced recompute when the conditions (clo/met …) change.
 */
import type { DeviceController } from '../device/controller';
import { LiveTracker } from '../device/live-tracker';
import type { Unsubscribe } from '../util/emitter';
import { computeComfort, type ComfortConditions } from './comfort';

/** Attach live derivation to a controller. */
export function attachComfort(ctrl: DeviceController, conditions: () => ComfortConditions): Unsubscribe {
  return ctrl.onSample(() => {
    const c = computeComfort(ctrl.live, conditions());
    ctrl.series.setDerived(ctrl.series.length - 1, c.mrt, c.pmv, c.ppd);
  });
}

/**
 * Recompute every derived value of the series by replaying its samples, yielding to the
 * event loop every `sliceMs` so the UI never stalls. Resolves false if aborted.
 */
export async function recomputeComfort(
  ctrl: DeviceController,
  conditions: ComfortConditions,
  signal?: AbortSignal,
  sliceMs = 5,
): Promise<boolean> {
  const series = ctrl.series;
  const tracker = new LiveTracker();
  tracker.setSettings(ctrl.snapshot.meta.settings);
  const n = series.length;
  let k = 0;
  while (k < n) {
    if (signal?.aborted) return false;
    const until = performance.now() + sliceMs;
    while (k < n && performance.now() < until) {
      const { ts, data } = series.sample(k);
      const live = tracker.apply(ts, data, 0);
      const c = computeComfort(live, conditions);
      series.setDerived(k, c.mrt, c.pmv, c.ppd);
      k += 1;
    }
    if (k < n) await new Promise((r) => setTimeout(r, 0));
  }
  series.touch();
  return true;
}
