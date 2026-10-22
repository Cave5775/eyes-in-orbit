import { EARTH } from '@eio/core';
import type { V3 } from './camera';

/**
 * Analytic Earth occlusion, shared by the picker, the label layer and the point shader (which has the same maths in GLSL).
 *
 * The Earth is the ellipsoid (a, a, b = a (1 - f)); scaling z by 1 / (1 - f) maps it to a sphere of radius `a`, so a ray
 * test against a sphere is exact for it. The test sphere is shrunk by a small margin so a marker lying ON the surface
 * (a pad, a landed booster) is never taken to be hidden by the ground it stands on.
 *
 * Positions are camera-relative where that matters: the ray starts at the camera (`origin`, world coordinates) and
 * ends at `origin + rel`. Keeping `rel` separate (computed in float64 by the caller) is what keeps the test accurate
 * for a camera metres away from the target.
 */

export const ELLIPSOID_K = 1 / (1 - EARTH.flattening);
/** Occluder radius reduction, km (above the mesh facet sag, below anything meant to hover above the ground). */
export const OCCLUSION_MARGIN_KM = 0.3;

/** `|o'|^2 - R'^2` for the camera in Earth-scaled space: > 0 when the camera is outside the (shrunk) Earth. */
export function occlusionC2(origin: V3, marginKm = OCCLUSION_MARGIN_KM): number {
  const ox = origin[0], oy = origin[1], oz = origin[2] * ELLIPSOID_K;
  const r = EARTH.radiusKm - marginKm;
  return ox * ox + oy * oy + oz * oz - r * r;
}

/** True when the (shrunk) Earth lies between the camera at `origin` and the point at `origin + rel`. */
export function earthOccludes(origin: V3, rel: V3, marginKm = OCCLUSION_MARGIN_KM): boolean {
  const c2 = occlusionC2(origin, marginKm);
  if (c2 <= 0) return false; // camera inside the planet: nothing sensible to hide
  const dx = rel[0], dy = rel[1], dz = rel[2] * ELLIPSOID_K;
  const L = Math.hypot(dx, dy, dz);
  if (L === 0) return false;
  const b = (origin[0] * dx + origin[1] * dy + origin[2] * ELLIPSOID_K * dz) / L;
  if (b >= 0) return false; // looking away from the centre
  const disc = b * b - c2;
  if (disc <= 0) return false; // the ray misses the sphere
  // nearest hit distance, in the form that does not cancel when the camera is close to the surface
  const t0 = c2 / (-b + Math.sqrt(disc));
  return t0 < L;
}

/** Geocentric distance beyond which the horizon test can be skipped because everything is far outside the planet. */
export const horizonDistanceKm = (altKm: number): number => Math.sqrt(Math.max(0, 2 * EARTH.radiusKm * altKm + altKm * altKm));
