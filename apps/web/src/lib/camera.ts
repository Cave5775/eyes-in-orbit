import { EARTH } from '@eio/core';

/** Pure camera maths (no three.js): altitude-scaled zoom, fit distance, local surface frames. Units km. */

export type V3 = [number, number, number];

const RE = EARTH.radiusKm;
const F = EARTH.flattening;

/** Closest the camera may get to the ellipsoid: clears the Earth mesh facet sag (~0.12 km) with a wide margin. */
export const MIN_ALT_KM = 3;
export const MAX_DIST_KM = 3e7;
/** Smallest camera-to-target distance when the target is not the Earth's centre (a followed object). */
export const MIN_TARGET_DIST_KM = 0.2;
/** Reference altitude is never taken below this, so the zoom step near the ground stays a usable size. */
const MIN_REF_KM = 1;

const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const n = len(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** Radius of the Earth ellipsoid (km) below the direction of `p` (geocentric, so approximate: fine for clamping). */
export function surfaceRadius(p: V3): number {
  const n = len(p);
  const s = n > 0 ? p[2] / n : 0;
  return RE * (1 - F * s * s);
}

/** Height of `p` above the ellipsoid, km (negative below). */
export const altitudeOf = (p: V3): number => len(p) - surfaceRadius(p);

/** The point on the ellipsoid under (radially below) `p`; `p` itself at the origin. */
export function groundPoint(p: V3, liftKm = 0): V3 {
  const n = len(p);
  if (n === 0) return [0, 0, 0];
  const k = (surfaceRadius(p) + liftKm) / n;
  return [p[0] * k, p[1] * k, p[2] * k];
}

/**
 * Wheel/pinch zoom that scales with height above the surface instead of with distance to the target.
 * Near the ground a notch moves the camera metres; at GEO it moves thousands of km. `factor` < 1 zooms in
 * (it is the multiplicative step the input produced, e.g. exp(deltaY * k)).
 *
 * The step is `ref * (factor - 1)` with `ref = min(dist, max(camAlt, minRefFrac * dist, 1 km))`:
 *  - orbiting the Earth's centre, dist = R + alt, so the altitude shrinks/grows by exactly `factor`;
 *  - orbiting a followed object, `ref` falls back to the (small) distance to it;
 *  - `minRefFrac` keeps surface-aligned views (camera low, looking along the ground) from freezing.
 */
export function zoomDistance(
  dist: number,
  factor: number,
  camAltKm: number,
  opts: { minDist: number; maxDist?: number; minRefFrac?: number },
): number {
  const ref = Math.min(dist, Math.max(camAltKm, (opts.minRefFrac ?? 0) * dist, MIN_REF_KM));
  const next = dist + ref * (factor - 1);
  return Math.min(opts.maxDist ?? MAX_DIST_KM, Math.max(opts.minDist, next));
}

/** Smallest elevation (rad above the local horizon) that keeps a camera at `dist` from the ground target above `minAltKm`. */
export function minElevation(distKm: number, minAltKm = MIN_ALT_KM): number {
  return distKm <= minAltKm ? Math.PI / 2 : Math.asin(Math.min(1, minAltKm / distKm));
}

/** Camera distance at which a sphere of `radius` fills the view with `margin` spare (>= 1) for both FOV axes. */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.25): number {
  const vHalf = (fovDeg * Math.PI) / 360;
  const hHalf = Math.atan(Math.tan(vHalf) * Math.max(0.05, aspect));
  return (Math.max(radius, 0) * margin) / Math.sin(Math.min(vHalf, hHalf));
}

/**
 * Bounding sphere of a flat xyz list (Ritter's algorithm with a second growth pass; within a few percent of
 * minimal and never smaller than needed). Empty input gives radius 0 at the origin.
 */
export function boundingSphere(pts: ArrayLike<number>, count = Math.floor(pts.length / 3)): { c: V3; r: number } {
  if (count <= 0) return { c: [0, 0, 0], r: 0 };
  const at = (i: number): V3 => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  const dist2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const farthest = (from: V3): number => {
    let best = 0, bd = -1;
    for (let i = 0; i < count; i++) {
      const d = dist2(from, at(i));
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const a = at(farthest(at(0)));
  const b = at(farthest(a));
  let c: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  let r = Math.sqrt(dist2(a, b)) / 2;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count; i++) {
      const p = at(i);
      const d = Math.sqrt(dist2(c, p));
      if (d > r) {
        const nr = (r + d) / 2;
        const k = (nr - r) / d;
        c = [c[0] + (p[0] - c[0]) * k, c[1] + (p[1] - c[1]) * k, c[2] + (p[2] - c[2]) * k];
        r = nr;
      }
    }
  }
  return { c, r };
}

/** Outward geodetic normal at a point on/near the ellipsoid (the local vertical). */
export function ellipsoidUp(p: V3): V3 {
  const k = 1 / ((1 - F) * (1 - F));
  return unit([p[0], p[1], p[2] * k]);
}

/**
 * East/north/up unit vectors for a local vertical `up` (north = towards +Z, i.e. north-up).
 * At the poles east is arbitrary (+Y).
 */
export function basisFromUp(up: V3): { e: V3; n: V3; u: V3 } {
  const u = unit(up);
  let e = cross([0, 0, 1], u);
  if (len(e) < 1e-9) e = [0, 1, 0];
  e = unit(e);
  return { e, n: cross(u, e), u };
}

/** East/north/up for geodetic latitude and (east) longitude in radians, in the frame the longitude refers to. */
export function localBasis(lat: number, lon: number): { e: V3; n: V3; u: V3 } {
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  return { e: [-so, co, 0], n: [-sl * co, -sl * so, cl], u: [cl * co, cl * so, sl] };
}

/** Camera offset from a target for azimuth (CCW from basis axis `e`, seen from above), elevation and distance. */
export function basisOffset(basis: { e: V3; n: V3; u: V3 }, az: number, el: number, dist: number): V3 {
  const ce = Math.cos(el) * dist, se = Math.sin(el) * dist;
  const ca = Math.cos(az), sa = Math.sin(az);
  return [
    ce * (ca * basis.e[0] + sa * basis.n[0]) + se * basis.u[0],
    ce * (ca * basis.e[1] + sa * basis.n[1]) + se * basis.u[1],
    ce * (ca * basis.e[2] + sa * basis.n[2]) + se * basis.u[2],
  ];
}

/** Azimuth that puts the camera south of the target so the view looks north (north-up). */
export const NORTH_UP_AZ = -Math.PI / 2;

/** Spherical interpolation of two directions (need not be unit). Antiparallel inputs rotate about an arbitrary perpendicular. */
export function slerpDir(a: V3, b: V3, k: number): V3 {
  const ua = unit(a), ub = unit(b);
  const d = Math.max(-1, Math.min(1, dot(ua, ub)));
  const ang = Math.acos(d);
  if (ang < 1e-6) return ua;
  let perp: V3;
  if (Math.PI - ang < 1e-6) {
    perp = cross(ua, Math.abs(ua[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]);
    perp = unit(perp);
    const th = Math.PI * k;
    const c = Math.cos(th), s = Math.sin(th);
    return [ua[0] * c + perp[0] * s, ua[1] * c + perp[1] * s, ua[2] * c + perp[2] * s];
  }
  const sa = Math.sin(ang);
  const w0 = Math.sin((1 - k) * ang) / sa, w1 = Math.sin(k * ang) / sa;
  return [ua[0] * w0 + ub[0] * w1, ua[1] * w0 + ub[1] * w1, ua[2] * w0 + ub[2] * w1];
}

/** Camera azimuth/elevation that views a subject at `c` from outside, with the Earth behind it; null when `c` is near the centre (keep the current angles). */
export function viewAnglesFor(c: V3, minRadius = RE * 1.2): { az: number; el: number } | null {
  const r = len(c);
  if (r < minRadius) return null;
  return { az: Math.atan2(c[1], c[0]), el: Math.max(-1.2, Math.min(1.2, Math.asin(c[2] / r) + 0.3)) };
}

/** Radians the FIT camera of a small, near-Earth subject is swung south of the local vertical (an oblique, north-facing view). */
export const SMALL_FIT_TILT = 0.75;

/**
 * Camera angles for FIT of a bounding sphere (`c`, `radius`). A small subject near the Earth (a booster and its pad, a
 * satellite and its children) is viewed obliquely from the south, so trajectories show their height instead of
 * collapsing into a top-down line; large or distant sets are viewed from outside with the Earth behind them.
 */
export function fitAngles(c: V3, radius: number): { az: number; el: number } | null {
  const r = len(c);
  if (r < 1) return null;
  if (radius < RE * 0.3 && r < RE * 3) {
    return { az: Math.atan2(c[1], c[0]), el: Math.max(-1.2, Math.min(1.2, Math.asin(c[2] / r) - SMALL_FIT_TILT)) };
  }
  return viewAnglesFor(c);
}
