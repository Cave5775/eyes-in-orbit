import type { Vec3 } from '@eio/core';

/** `compressed`: objects beyond the shell threshold sit on the log-compressed shell (default); `true`: real geocentric positions. */
export type DistanceScale = 'compressed' | 'true';

/** Beyond this geocentric distance (km) positions are drawn on a compressed shell. */
export const SHELL_THRESHOLD_KM = 2e6;
/** Shell growth per decade of real distance, as a fraction of the threshold radius. */
const SHELL_PER_DECADE = 0.25;

/**
 * Display radius for a geocentric distance. Identity inside the threshold, then logarithmic,
 * continuous at the threshold and monotonic: 2e6 km -> 2e6, 2e7 -> 2.5e6, 2.5e10 (Voyager 1) -> ~4.0e6.
 */
export function shellRadius(rKm: number): number {
  if (rKm <= SHELL_THRESHOLD_KM) return rKm;
  return SHELL_THRESHOLD_KM * (1 + SHELL_PER_DECADE * Math.log10(rKm / SHELL_THRESHOLD_KM));
}

/** Direction-preserving compression of deep-space positions onto the display shell. */
export function compressDeepSpace(r: Vec3): { r: Vec3; compressed: boolean } {
  const n = Math.hypot(r[0], r[1], r[2]);
  if (n <= SHELL_THRESHOLD_KM) return { r, compressed: false };
  const k = shellRadius(n) / n;
  return { r: [r[0] * k, r[1] * k, r[2] * k], compressed: true };
}
