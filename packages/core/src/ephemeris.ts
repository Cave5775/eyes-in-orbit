import { DEG, J2000_MS, MS_PER_DAY, Vec3, wrap2Pi } from './math';

/**
 * Low-precision (~0.01 deg) unit vector from Earth to the Sun in the Earth-inertial
 * (equatorial, of-date ~ TEME) frame. Used for day/night shading and eclipse hints.
 */
export function sunDirectionEci(tMs: number): Vec3 {
  const n = (tMs - J2000_MS) / MS_PER_DAY;
  const L = wrap2Pi((280.46 + 0.9856474 * n) * DEG);
  const g = wrap2Pi((357.528 + 0.9856003 * n) * DEG);
  const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  return [Math.cos(lambda), Math.cos(eps) * Math.sin(lambda), Math.sin(eps) * Math.sin(lambda)];
}
