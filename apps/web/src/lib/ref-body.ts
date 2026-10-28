import { EARTH, bodyStateEci, defaultBodies, type Vec3 } from '@eio/core';
import { MIN_ALT_KM } from './camera';

/**
 * Reference bodies: the body the view is centred on and the one readouts are measured from. Entities stay stored in
 * Earth-inertial coordinates; the renderer subtracts the camera in float64, so centring the camera on the Moon or the Sun
 * re-expresses every position, orbit line, footprint and model relative to that body without touching the buffers.
 *
 * Any registry body id works (`MARS` too); the literal names keep their autocompletion, other strings are accepted.
 */
export type RefBody = 'EARTH' | 'MOON' | 'SUN' | (string & {});

/** True for any body of the core registry (Sun, Earth, Moon, Mars, ...). */
export const isRegistryBody = (s: unknown): s is RefBody => typeof s === 'string' && defaultBodies.has(s);

/**
 * Limit of the near-Earth neighbourhood (km, geocentric): beyond it an object is "deep space", so it has no latitude,
 * longitude or altitude readout, no Earth-orbit period and no orbit line of its own (a non-body entity), and the browser
 * scope filter calls it distant. A classification only: positions are never moved (everything is drawn to scale).
 */
export const NEAR_EARTH_LIMIT_KM = 2e6;

/** Display name and true radius of every registry body, by id. */
export const REF_LABEL: Record<string, string> = Object.fromEntries(defaultBodies.all().map((b) => [b.id, b.name]));

export const REF_RADIUS_KM: Record<string, number> = Object.fromEntries(defaultBodies.all().map((b) => [b.id, b.radiusKm]));

/** True radius of a body (km), read from the registry as it is now (a body registered later counts); an id it does not know gets the Earth's, so nothing divides by zero. */
export const refRadiusKm = (body: RefBody): number => (defaultBodies.has(body) ? defaultBodies.get(body).radiusKm : EARTH.radiusKm);

/** Centre of the body in the Earth-inertial frame at `tMs`, km (core `bodyStateEci`; the origin for an unknown body). */
export function refPositionEci(body: RefBody, tMs: number): Vec3 {
  if (body === 'EARTH' || !defaultBodies.has(body)) return [0, 0, 0];
  return bodyStateEci(body, tMs).r;
}

/**
 * Where a body is drawn: `r` is its centre (km, Earth-inertial) and `k` the factor its radius is drawn with. Everything is
 * drawn to scale (the Sun at 1.5e8 km, Mars at 1e8 to 4e8 km, probes at their real distance), so `k` is always 1; the field
 * stays only because the pick, disc-hide and label code still carry it (a follow-up cleanup removes it).
 */
export function refDisplay(body: RefBody, tMs: number): { r: Vec3; k: number } {
  return { r: refPositionEci(body, tMs), k: 1 };
}

/**
 * Camera distance (from the body's centre) that frames the whole body when the view is centred on it: the Earth 24,000 km, any
 * other body 4 radii, so its disc spans about a quarter of the view height or more. In the true scale: the Moon 6,950 km, Mars
 * 13,600 km (its close orbiters, MAVEN, MRO, are inside the view), the Sun 2.8e6 km (a disc filling the view, the Earth's orbit
 * at 1.5e8 km is zoomed out to).
 */
export const refViewDistKm = (body: RefBody): number => (body === 'EARTH' ? 24000 : refRadiusKm(body) * 4);

/**
 * Closest the camera may come to the body's centre while it is the view centre: just above its surface (the
 * Earth: the camera's usual minimum altitude, the same as when nothing is followed).
 */
export const refMinDistKm = (body: RefBody): number => (body === 'EARTH' ? EARTH.radiusKm + MIN_ALT_KM : refRadiusKm(body) * 1.02);

/** `r` (Earth-inertial, km) relative to the body's centre. Same axes, so this is a translation. */
export function relativeToRef(body: RefBody, r: Vec3, tMs: number): Vec3 {
  const c = refPositionEci(body, tMs);
  return [r[0] - c[0], r[1] - c[1], r[2] - c[2]];
}
