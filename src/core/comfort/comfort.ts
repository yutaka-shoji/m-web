/**
 * Derived thermal-comfort values for one device, from its latest display state.
 * Gating follows the official app: nothing is shown until air temperature, humidity, globe
 * temperature and air speed have all been measured, and nothing while the TH/CO₂ or air-speed
 * probe is warming up or disconnected. Out-of-range inputs are flagged, not hidden.
 */
import type { LiveState, ValueStatus } from '../device/live-tracker';
import { meanRadiantTemperature } from './mrt';
import { iso7730RangeIssues, pmvPpd, relativeAirSpeed, type RangeIssue } from './pmv';

export interface ComfortConditions {
  /** Clothing insulation [clo]. */
  clo: number;
  /** Metabolic rate [met]. */
  met: number;
  /** Use the ISO 7730 relative air speed v + 0.3(M−1) instead of the measured speed. */
  relativeSpeed: boolean;
  /** Air speed assumed when the velocity probe is off; null = do not assume. */
  assumedAirSpeed: number | null;
}

/** Defaults of the official app's live view. */
export const DEFAULT_CONDITIONS: ComfortConditions = {
  clo: 1.0,
  met: 1.1,
  relativeSpeed: false,
  assumedAirSpeed: null,
};

export type ComfortStatus = 'ok' | 'waiting' | 'warming' | 'disconnected' | 'no_velocity' | 'not_converged';

export interface ComfortValue {
  readonly mrt: number | null;
  readonly pmv: number | null;
  readonly ppd: number | null;
  readonly status: ComfortStatus;
  readonly issues: readonly RangeIssue[];
  /** The assumed air speed was used. */
  readonly assumedSpeed: boolean;
}

const blank = (status: ComfortStatus): ComfortValue => ({
  mrt: null,
  pmv: null,
  ppd: null,
  status,
  issues: [],
  assumedSpeed: false,
});

function gate(statuses: ValueStatus[]): ComfortStatus | null {
  if (statuses.includes('disconnected')) return 'disconnected';
  if (statuses.includes('warming')) return 'warming';
  return null;
}

export function computeComfort(live: LiveState, cond: ComfortConditions): ComfortValue {
  const { t, h, g, v } = live.values;
  const velocityMeasured = v.status === 'ok' && v.value !== null;
  const velocityAssumable = !velocityMeasured && (v.status === 'off' || v.status === 'none' || v.status === 'invalid');
  // A disabled velocity probe does not block when an air speed is assumed.
  const vGate: ValueStatus = velocityAssumable && cond.assumedAirSpeed !== null ? 'ok' : v.status;
  const blocking = gate([t.status, h.status, g.status, vGate]);
  if (blocking) return blank(blocking);
  if (t.value === null || h.value === null || g.value === null) return blank('waiting');

  let speed: number;
  let assumedSpeed = false;
  if (velocityMeasured) speed = v.value!;
  else if (velocityAssumable && cond.assumedAirSpeed !== null) {
    speed = cond.assumedAirSpeed;
    assumedSpeed = true;
  } else return blank(v.status === 'off' ? 'no_velocity' : 'waiting');

  const mrt = meanRadiantTemperature(t.value, g.value, speed);
  const vr = cond.relativeSpeed ? relativeAirSpeed(speed, cond.met) : speed;
  const input = { ta: t.value, tr: mrt, vr, rh: h.value, met: cond.met, clo: cond.clo };
  const { pmv, ppd } = pmvPpd(input);
  if (!Number.isFinite(pmv)) return { ...blank('not_converged'), mrt };
  return { mrt, pmv, ppd, status: 'ok', issues: iso7730RangeIssues(input, pmv), assumedSpeed };
}
