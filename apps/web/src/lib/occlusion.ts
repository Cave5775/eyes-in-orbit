import { EARTH } from '@eio/core';
import type { V3 } from './camera';

/**
 * Analytic Earth occlusion, shared by the picker, the label layer and the point shader (which has the same maths in GLSL).
 * The displayed Moon and Sun are added as plain spheres (`OccluderSphere`, `sphereOccludes`), tested the same way.
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

/**
 * How far the middle of a straight chord of `chordKm` between two points on a sphere of radius `radiusKm` sinks below the
 * surface. A depth-tested line drawn along the ground between widely spaced points (a ground track, the footprint circle)
 * dips under the Earth mesh by this much and shows as dashes unless its vertices are lifted by at least it.
 */
export function chordSagKm(chordKm: number, radiusKm: number = EARTH.radiusKm): number {
  const h = Math.min(chordKm / 2, radiusKm);
  return radiusKm - Math.sqrt(radiusKm * radiusKm - h * h);
}

/**
 * A sphere that hides what is behind it: the Moon or the Sun (`c` = centre, the same frame as the camera
 * `origin`; `r` = radius).
 */
export interface OccluderSphere {
  c: V3;
  r: number;
}

/**
 * A sphere seen from the camera, in the form the point shader receives: `(x, y, z)` is the centre RELATIVE to the camera
 * (subtracted in float64 here, so the Sun at 1.5e8 km and the Moon 3,000 km away are both exact to float32 rounding of
 * the result), `r` the shrunk radius and `c2 = |centre|^2 - r^2` (computed in float64: > 0 when the camera is outside).
 */
export interface SphereView {
  x: number;
  y: number;
  z: number;
  r: number;
  c2: number;
}

/** Margin for a sphere: the Earth's absolute margin, but never more than 1 % of the radius (a small, far Sun). */
const sphereMargin = (r: number, marginKm: number): number => Math.min(marginKm, r * 0.01);

export function sphereView(origin: V3, s: OccluderSphere, marginKm = OCCLUSION_MARGIN_KM): SphereView {
  const x = s.c[0] - origin[0], y = s.c[1] - origin[1], z = s.c[2] - origin[2];
  const r = s.r - sphereMargin(s.r, marginKm);
  return { x, y, z, r, c2: x * x + y * y + z * z - r * r };
}

/**
 * True when the sphere `v` (camera-relative centre, see `sphereView`) lies between the camera and the point `rel`
 * (camera-relative). Only a point whose segment to the camera crosses the sphere is hidden: a point on the camera side
 * of the near surface, beside the sphere, or looking away from it is not. A point inside the sphere is hidden.
 *
 * Written the way the shader is, to stay accurate in float32 for huge distances: the miss distance is the length of
 * `cross(u, centre)` (no `|centre|^2 - t^2` cancellation) and the near hit is `c2 / (b + sqrt((r - p)(r + p)))`.
 */
export function sphereOccludes(v: SphereView, rx: number, ry: number, rz: number): boolean {
  if (v.c2 <= 0) return false; // camera inside the sphere: nothing sensible to hide
  const L = Math.hypot(rx, ry, rz);
  if (L === 0) return false;
  const ux = rx / L, uy = ry / L, uz = rz / L;
  const b = ux * v.x + uy * v.y + uz * v.z;
  if (b <= 0) return false; // looking away from the centre
  const cx = uy * v.z - uz * v.y, cy = uz * v.x - ux * v.z, cz = ux * v.y - uy * v.x;
  const p = Math.hypot(cx, cy, cz);
  if (p >= v.r) return false; // the ray misses the sphere
  return v.c2 / (b + Math.sqrt((v.r - p) * (v.r + p))) < L;
}

/**
 * `earthOccludes` (plus the Moon and Sun spheres, when given) for many points from one camera: the camera terms are
 * computed once and no arrays are allocated per point (the scope pass tests every catalogue object a few times a second).
 * The Earth part is unchanged; `spheres` only add to what is hidden.
 */
export function makeOccluder(
  origin: V3,
  marginKm = OCCLUSION_MARGIN_KM,
  spheres: readonly OccluderSphere[] = [],
): (rx: number, ry: number, rz: number) => boolean {
  const c2 = occlusionC2(origin, marginKm);
  const ox = origin[0], oy = origin[1], oz = origin[2] * ELLIPSOID_K;
  const views = spheres.map((s) => sphereView(origin, s, marginKm)).filter((v) => v.c2 > 0);
  const earth = c2 > 0;
  if (!earth && views.length === 0) return () => false;
  return (rx, ry, rz) => {
    if (earth) {
      const dz = rz * ELLIPSOID_K;
      const L = Math.hypot(rx, ry, dz);
      if (L !== 0) {
        const b = (ox * rx + oy * ry + oz * dz) / L;
        if (b < 0) {
          const disc = b * b - c2;
          if (disc > 0 && c2 / (-b + Math.sqrt(disc)) < L) return true;
        }
      }
    }
    for (let i = 0; i < views.length; i++) if (sphereOccludes(views[i], rx, ry, rz)) return true;
    return false;
  };
}

/** Geocentric distance beyond which the horizon test can be skipped because everything is far outside the planet. */
export const horizonDistanceKm = (altKm: number): number => Math.sqrt(Math.max(0, 2 * EARTH.radiusKm * altKm + altKm * altKm));
