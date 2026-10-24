import { EARTH, MOON, SUN, moonPositionEci, sunPositionEci, type Vec3 } from '@eio/core';
import { shellRadius, type DistanceScale } from './deepspace';

/**
 * Reference bodies: the body the view is centred on and the one readouts are measured from. Entities stay stored in
 * Earth-inertial coordinates; the renderer subtracts the camera in float64, so centring the camera on the Moon or the Sun
 * re-expresses every position, orbit line, footprint and model relative to that body without touching the buffers.
 */
export type RefBody = 'EARTH' | 'MOON' | 'SUN';

export const REF_BODIES: readonly RefBody[] = ['EARTH', 'MOON', 'SUN'];

export const isRefBody = (s: unknown): s is RefBody => s === 'EARTH' || s === 'MOON' || s === 'SUN';

export const REF_LABEL: Record<RefBody, string> = { EARTH: 'Earth', MOON: 'Moon', SUN: 'Sun' };

export const REF_RADIUS_KM: Record<RefBody, number> = { EARTH: EARTH.radiusKm, MOON: MOON.radiusKm, SUN: SUN.radiusKm };

/** Centre of the body in the Earth-inertial frame at `tMs`, km. */
export function refPositionEci(body: RefBody, tMs: number): Vec3 {
  return body === 'MOON' ? moonPositionEci(tMs) : body === 'SUN' ? sunPositionEci(tMs) : [0, 0, 0];
}

/**
 * Where a body is drawn and how much it is shrunk: `r` is its centre in display space (km) and `k` the factor that took
 * it there. In the compressed distance scale the Sun (1.5e8 km) sits on the deep-space shell exactly like a probe in the
 * same direction, and `k` < 1 scales its radius by the same factor, so it keeps its true angular size seen from the Earth.
 * The Moon is inside the shell threshold and the true scale draws everything as it is: `k` = 1.
 */
export function refDisplay(body: RefBody, tMs: number, scale: DistanceScale): { r: Vec3; k: number } {
  const r = refPositionEci(body, tMs);
  if (scale === 'true') return { r, k: 1 };
  const n = Math.hypot(r[0], r[1], r[2]);
  const k = n > 0 ? shellRadius(n) / n : 1;
  return { r: [r[0] * k, r[1] * k, r[2] * k], k };
}

/** Camera distance (from the body's centre) that frames the whole body when the view is centred on it. `k`: see refDisplay. */
export const refViewDistKm = (body: RefBody, k = 1): number => (body === 'EARTH' ? 24000 : REF_RADIUS_KM[body] * k * 4);

/** Closest the camera may come to the body's centre while it is the view centre: just above its (displayed) surface. */
export const refMinDistKm = (body: RefBody, k = 1): number => REF_RADIUS_KM[body] * k * 1.02;

/**
 * Farthest the camera may be from the view centre. In the true distance scale the Sun view must reach the Earth's orbit
 * (1.5e8 km) to show the Earth and Moon next to it; the compressed shell already fits inside every scale's own limit.
 */
export const refMaxDistKm = (body: RefBody, scaleMaxKm: number, scale: DistanceScale = 'true'): number =>
  body === 'SUN' && scale === 'true' ? Math.max(scaleMaxKm, 6e8) : scaleMaxKm;

/** `r` (Earth-inertial, km) relative to the body's centre. Same axes, so this is a translation. */
export function relativeToRef(body: RefBody, r: Vec3, tMs: number): Vec3 {
  const c = refPositionEci(body, tMs);
  return [r[0] - c[0], r[1] - c[1], r[2] - c[2]];
}
