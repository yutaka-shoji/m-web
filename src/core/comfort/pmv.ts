/**
 * PMV / PPD after ISO 7730:2005, Annex D (the standard's reference program), the same
 * Fanger heat-balance iteration the official app uses (Popolo FangerModel).
 * Pure function: a few microseconds per call, so no WASM or caching is needed.
 */

export interface PmvInput {
  /** Air temperature [°C] */
  ta: number;
  /** Mean radiant temperature [°C] */
  tr: number;
  /** Relative air speed [m/s] */
  vr: number;
  /** Relative humidity [%] */
  rh: number;
  /** Metabolic rate [met] */
  met: number;
  /** Clothing insulation [clo] */
  clo: number;
  /** External work [met], normally 0 */
  wme?: number;
}

export interface PmvResult {
  pmv: number;
  ppd: number;
}

/** Returns NaN values if the clothing-temperature iteration does not converge. */
export function pmvPpd({ ta, tr, vr, rh, met, clo, wme = 0 }: PmvInput): PmvResult {
  const pa = rh * 10 * Math.exp(16.6536 - 4030.183 / (ta + 235)); // water vapour pressure [Pa]
  const icl = 0.155 * clo; // [m²K/W]
  const m = met * 58.15; // [W/m²]
  const w = wme * 58.15;
  const mw = m - w;
  const fcl = icl <= 0.078 ? 1 + 1.29 * icl : 1.05 + 0.645 * icl;
  const hcf = 12.1 * Math.sqrt(Math.max(0, vr));
  const taa = ta + 273;
  const tra = tr + 273;
  const tcla = taa + (35.5 - ta) / (3.5 * icl + 0.1);

  const p1 = icl * fcl;
  const p2 = p1 * 3.96;
  const p3 = p1 * 100;
  const p4 = p1 * taa;
  const p5 = 308.7 - 0.028 * mw + p2 * Math.pow(tra / 100, 4);
  let xn = tcla / 100;
  let xf = tcla / 50;
  let hc = hcf;
  let n = 0;
  while (Math.abs(xn - xf) > 0.00015) {
    xf = (xf + xn) / 2;
    const hcn = 2.38 * Math.pow(Math.abs(100 * xf - taa), 0.25);
    hc = hcf > hcn ? hcf : hcn;
    xn = (p5 + p4 * hc - p2 * Math.pow(xf, 4)) / (100 + p3 * hc);
    if (++n > 150) return { pmv: NaN, ppd: NaN };
  }
  const tcl = 100 * xn - 273;

  const hl1 = 3.05 * 0.001 * (5733 - 6.99 * mw - pa); // skin diffusion
  const hl2 = mw > 58.15 ? 0.42 * (mw - 58.15) : 0; // sweating
  const hl3 = 1.7 * 0.00001 * m * (5867 - pa); // latent respiration
  const hl4 = 0.0014 * m * (34 - ta); // dry respiration
  const hl5 = 3.96 * fcl * (Math.pow(xn, 4) - Math.pow(tra / 100, 4)); // radiation
  const hl6 = fcl * hc * (tcl - ta); // convection
  const ts = 0.303 * Math.exp(-0.036 * m) + 0.028;
  const pmv = ts * (mw - hl1 - hl2 - hl3 - hl4 - hl5 - hl6);
  return { pmv, ppd: ppdFromPmv(pmv) };
}

export function ppdFromPmv(pmv: number): number {
  const p2 = pmv * pmv;
  return 100 - 95 * Math.exp(-0.03353 * p2 * p2 - 0.2179 * p2);
}

/** ISO 7730 relative air speed for an active person: v + 0.3·(M − 1) above 1 met. */
export function relativeAirSpeed(v: number, met: number): number {
  return met > 1 ? v + 0.3 * (met - 1) : v;
}

export type RangeIssue = 'ta' | 'tr' | 'vr' | 'pa' | 'met' | 'clo' | 'pmv';

/**
 * Inputs (and the result) outside the ISO 7730 range of applicability. Values are still
 * computed and shown — only flagged — so readers can judge them.
 */
export function iso7730RangeIssues(input: PmvInput, pmv: number): RangeIssue[] {
  const issues: RangeIssue[] = [];
  const pa = input.rh * 10 * Math.exp(16.6536 - 4030.183 / (input.ta + 235));
  if (input.ta < 10 || input.ta > 30) issues.push('ta');
  if (input.tr < 10 || input.tr > 40) issues.push('tr');
  if (input.vr < 0 || input.vr > 1) issues.push('vr');
  if (pa < 0 || pa > 2700) issues.push('pa');
  if (input.met < 0.8 || input.met > 4) issues.push('met');
  if (input.clo < 0 || input.clo > 2) issues.push('clo');
  if (Number.isFinite(pmv) && (pmv < -2 || pmv > 2)) issues.push('pmv');
  return issues;
}
