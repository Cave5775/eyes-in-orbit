import { EARTH, bodyStateEci, defaultBodies, type Vec3 } from '@eio/core';
import { shellRadius, type DistanceScale } from './deepspace';

/**
 * Reference bodies: the body the view is centred on and the one readouts are measured from. Entities stay stored in
 * Earth-inertial coordinates; the renderer subtracts the camera in float64, so centring the camera on the Moon or the Sun
 * re-expresses every position, orbit line, footprint and model relative to that body without touching the buffers.
 *
 * Any registry body id works (`MARS` too); the literal names keep their autocompletion, other strings are accepted.
 */
export type RefBody = 'EARTH' | 'MOON' | 'SUN' | (string & {});

/** The bodies the scene has drawn since the first frame work (Earth, Moon, Sun); the registry may hold more. */
export const REF_BODIES: readonly RefBody[] = ['EARTH', 'MOON', 'SUN'];

/** True for the three original reference bodies. For "is this a body of the registry" use `isRegistryBody`. */
export const isRefBody = (s: unknown): s is RefBody => s === 'EARTH' || s === 'MOON' || s === 'SUN';

/** True for any body of the core registry (Sun, Earth, Moon, Mars, ...). */
export const isRegistryBody = (s: unknown): s is RefBody => typeof s === 'string' && defaultBodies.has(s);

/** Display name and true radius of every registry body, by id. */
export const REF_LABEL: Record<string, string> = Object.fromEntries(defaultBodies.all().map((b) => [b.id, b.name]));

export const REF_RADIUS_KM: Record<string, number> = Object.fromEntries(defaultBodies.all().map((b) => [b.id, b.radiusKm]));

/** True radius of a body (km); an id the registry does not know gets the Earth's, so nothing divides by zero. */
export const refRadiusKm = (body: RefBody): number => REF_RADIUS_KM[body] ?? EARTH.radiusKm;

/** Centre of the body in the Earth-inertial frame at `tMs`, km (core `bodyStateEci`; the origin for an unknown body). */
export function refPositionEci(body: RefBody, tMs: number): Vec3 {
  if (body === 'EARTH' || !defaultBodies.has(body)) return [0, 0, 0];
  return bodyStateEci(body, tMs).r;
}

/**
 * Where a body is drawn and how much it is shrunk: `r` is its centre in display space (km) and `k` the factor that took
 * it there. In the compressed distance scale a body beyond the shell threshold (the Sun at 1.5e8 km, Mars at 1e8 to 4e8 km)
 * sits on the deep-space shell exactly like a probe in the same direction, and `k` < 1 scales its radius by the same
 * factor, so it keeps its true angular size seen from the Earth. The Moon is inside the shell threshold and the true
 * scale draws everything as it is: `k` = 1.
 */
export function refDisplay(body: RefBody, tMs: number, scale: DistanceScale): { r: Vec3; k: number } {
  const r = refPositionEci(body, tMs);
  if (scale === 'true') return { r, k: 1 };
  const n = Math.hypot(r[0], r[1], r[2]);
  const k = n > 0 ? shellRadius(n) / n : 1;
  return { r: [r[0] * k, r[1] * k, r[2] * k], k };
}

/** Camera distance (from the body's centre) that frames the whole body when the view is centred on it. `k`: see refDisplay. */
export const refViewDistKm = (body: RefBody, k = 1): number => (body === 'EARTH' ? 24000 : refRadiusKm(body) * k * 4);

/** Closest the camera may come to the body's centre while it is the view centre: just above its (displayed) surface. */
export const refMinDistKm = (body: RefBody, k = 1): number => refRadiusKm(body) * k * 1.02;

/** A body that orbits the Sun directly and is not the Earth: far away in the true scale (Mars, later asteroids). */
function isHeliocentricFar(body: RefBody): boolean {
  if (body === 'SUN') return true;
  return body !== 'EARTH' && defaultBodies.has(body) && defaultBodies.get(body).parentId === 'SUN';
}

/**
 * Farthest the camera may be from the view centre. In the true distance scale the Sun view must reach the Earth's orbit
 * (1.5e8 km) to show the Earth and Moon next to it, and a planet's view must reach the Earth from Mars distance; the
 * compressed shell already fits inside every scale's own limit.
 */
export const refMaxDistKm = (body: RefBody, scaleMaxKm: number, scale: DistanceScale = 'true'): number =>
  isHeliocentricFar(body) && scale === 'true' ? Math.max(scaleMaxKm, 6e8) : scaleMaxKm;

/** `r` (Earth-inertial, km) relative to the body's centre. Same axes, so this is a translation. */
export function relativeToRef(body: RefBody, r: Vec3, tMs: number): Vec3 {
  const c = refPositionEci(body, tMs);
  return [r[0] - c[0], r[1] - c[1], r[2] - c[2]];
}
