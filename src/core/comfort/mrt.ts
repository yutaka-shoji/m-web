/**
 * Mean radiant temperature from the M-Logger's globe thermometer (ISO 7726 Annex B), with the
 * same constants and form as the official app (MLS_Mobile DataReceiveViewModel.GetMRT):
 * a table-tennis-ball globe (D = 38 mm, ε = 0.95); the convective coefficient is the larger
 * of natural (1.4·(ΔT/D)^0.25) and forced (6.3·v^0.6/D^0.4) convection.
 */
export const GLOBE_DIAMETER_M = 0.038;
export const GLOBE_EMISSIVITY = 0.95;
const SIGMA = 5.67e-8;

/**
 * @param ta air temperature [°C]
 * @param tg globe temperature [°C]
 * @param v  air speed [m/s]
 * @returns mean radiant temperature [°C]
 */
export function meanRadiantTemperature(
  ta: number,
  tg: number,
  v: number,
  d: number = GLOBE_DIAMETER_M,
  emissivity: number = GLOBE_EMISSIVITY,
): number {
  const hcNatural = 1.4 * Math.pow(Math.abs(ta - tg) / d, 0.25);
  const hcForced = (6.3 * Math.pow(Math.max(0, v), 0.6)) / Math.pow(d, 0.4);
  const tgK = tg + 273.15;
  const inner = Math.pow(tgK, 4) + (Math.max(hcNatural, hcForced) / (emissivity * SIGMA)) * (tg - ta);
  return Math.pow(Math.max(0, inner), 0.25) - 273.15;
}
