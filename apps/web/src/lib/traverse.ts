import { convert, defaultBodies, enuBasis, surfaceShape, type FrameId, type StateVector, type Vec3 } from '@eio/core';
import { fitDistanceClamped, MIN_TARGET_DIST_KM, type V3 } from './camera';

/**
 * A rover's traverse on its body, and the Close-up view of a surface object (pure, no three.js).
 *
 * The traverse (`GET /api/traverse/:id`, core `RoverTraverse`) is a list of `[latDeg, lonDeg, sol]` on the body's sphere
 * (`surfaceShape`, the shape the sites are placed on). It is turned into body-fixed points once per data change
 * (`traverseFixed`, a few metres above the drawn surface so the line is not buried in the mesh) and into world points every
 * frame (`traverseWorld`) from the body's frame at that moment: the Mars-fixed to Earth-inertial transform is affine, so four
 * conversions (`bodyAxes`: the origin and the three axes) place any number of points, in float64, ready to be made
 * camera-relative like every other position.
 */

/** The traverse line lies this far above the sphere, km (10 m: above float32 noise in the mesh, below anything one could see float). */
export const TRAVERSE_LIFT_KM = 0.01;

const DEG = Math.PI / 180;
const AXIS_LEVER_KM = 1000;

/** Body-fixed xyz (km) of the traverse points into `out` (3 per point); returns the count. */
export function traverseFixed(points: readonly (readonly number[])[], bodyId: string, out: Float64Array, liftKm = TRAVERSE_LIFT_KM): number {
  const r = surfaceShape(defaultBodies.get(bodyId)).radiusKm + liftKm;
  const n = Math.min(points.length, out.length / 3);
  for (let i = 0; i < n; i++) {
    const lat = points[i][0] * DEG, lon = points[i][1] * DEG;
    const cl = Math.cos(lat);
    out[i * 3] = r * cl * Math.cos(lon);
    out[i * 3 + 1] = r * cl * Math.sin(lon);
    out[i * 3 + 2] = r * Math.sin(lat);
  }
  return n;
}

/** The body-fixed frame as seen from the Earth-inertial scene: world = `o` + x `ex` + y `ey` + z `ez`. */
export interface BodyAxes {
  o: Vec3;
  ex: Vec3;
  ey: Vec3;
  ez: Vec3;
}

/** The body-fixed axes in the scene's Earth-inertial space at `tMs`, or null when the body has no state then. */
export function bodyAxes(bodyId: string, tMs: number): BodyAxes | null {
  const fixed = `${bodyId}:fixed` as FrameId;
  const at = (r: Vec3): Vec3 | null => {
    try {
      const s: StateVector = { frame: fixed, r };
      const w = convert(s, 'EARTH:inertial' as FrameId, tMs).r;
      return Number.isFinite(w[0] + w[1] + w[2]) ? w : null;
    } catch {
      return null;
    }
  };
  // a long lever arm: the positions are 1e8 km (Mars) and a double keeps about 3e-8 km of them, so one-km axes would carry 3e-8 of error
  const L = AXIS_LEVER_KM;
  const o = at([0, 0, 0]), x = at([L, 0, 0]), y = at([0, L, 0]), z = at([0, 0, L]);
  if (!o || !x || !y || !z) return null;
  return {
    o, ex: [(x[0] - o[0]) / L, (x[1] - o[1]) / L, (x[2] - o[2]) / L], ey: [(y[0] - o[0]) / L, (y[1] - o[1]) / L, (y[2] - o[2]) / L], ez: [(z[0] - o[0]) / L, (z[1] - o[1]) / L, (z[2] - o[2]) / L],
  };
}

/** Earth-inertial xyz of `count` body-fixed points into `out` (3 per point). */
export function traverseWorld(fixed: Float64Array, count: number, a: BodyAxes, out: Float64Array): void {
  for (let i = 0; i < count; i++) {
    const x = fixed[i * 3], y = fixed[i * 3 + 1], z = fixed[i * 3 + 2];
    out[i * 3] = a.o[0] + x * a.ex[0] + y * a.ey[0] + z * a.ez[0];
    out[i * 3 + 1] = a.o[1] + x * a.ex[1] + y * a.ey[1] + z * a.ez[1];
    out[i * 3 + 2] = a.o[2] + x * a.ex[2] + y * a.ey[2] + z * a.ez[2];
  }
}

/** Largest distance from the body-fixed point `c` (3 numbers) to any of the `count` body-fixed points, km. */
export function reachFrom(fixed: Float64Array, count: number, c: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < count; i++) m = Math.max(m, Math.hypot(fixed[i * 3] - c[0], fixed[i * 3 + 1] - c[1], fixed[i * 3 + 2] - c[2]));
  return m;
}

// ---------------------------------------------------------------------------------------------------------------- Close-up

/** Camera elevation over the local horizon of a surface object's Close-up, radians (looking down at it, not straight down). */
export const CLOSE_UP_ELEVATION = (45 * Math.PI) / 180;
/** Camera distance of the Close-up of a surface object with nothing else to frame, km: 4 km, about 2.8 km above the ground at 45 degrees. */
export const CLOSE_UP_DIST_KM = 4;

const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * Unit vector from the object to the Close-up camera: `CLOSE_UP_ELEVATION` over the local horizon, on the side the Sun is
 * (so the object is lit), or toward the east when the Sun is on the vertical. `up` is the
 * local vertical (the object's position from its body's centre), `sun` the direction to the Sun; both in the same frame.
 */
export function closeUpDirection(up: V3, sun: V3): V3 {
  const u = norm(up);
  const d = sun[0] * u[0] + sun[1] * u[1] + sun[2] * u[2];
  let h: V3 = [sun[0] - d * u[0], sun[1] - d * u[1], sun[2] - d * u[2]];
  if (Math.hypot(h[0], h[1], h[2]) < 1e-6) {
    // the Sun is on the vertical: any horizontal direction, here east (the body's +z cross up; the polar case falls back to +x)
    const e: V3 = [-u[1], u[0], 0];
    h = Math.hypot(e[0], e[1]) < 1e-6 ? [1, 0, 0] : e;
  }
  h = norm(h);
  const c = Math.cos(CLOSE_UP_ELEVATION), s = Math.sin(CLOSE_UP_ELEVATION);
  return [h[0] * c + u[0] * s, h[1] * c + u[1] * s, h[2] * c + u[2] * s];
}

/**
 * Camera distance of the Close-up: `CLOSE_UP_DIST_KM` for an object alone, or the distance at which everything within
 * `reachKm` of it (its traverse) fits the view, when that is larger.
 */
export function closeUpDistance(reachKm: number, fovDeg: number, aspect: number, margin: number): number {
  return Math.max(CLOSE_UP_DIST_KM, fitDistanceClamped(reachKm, fovDeg, aspect, margin, MIN_TARGET_DIST_KM));
}

// ------------------------------------------------------------------------------------------ the site's local frame

/** East, north and up of a site, as unit vectors in the Earth-inertial scene frame at one moment. */
export interface LocalBasis {
  e: V3;
  n: V3;
  u: V3;
}

/**
 * The local east/north/up of a surface site in the scene's Earth-inertial axes at `tMs` (the body's rotation turns it: Mars
 * 14.6 degrees an hour). The Close-up keeps its camera offset in this frame, so it keeps looking at the site from the same
 * side and height while the planet turns. Null when the body has no state then.
 */
export function siteBasis(bodyId: string, latDeg: number, lonDeg: number, tMs: number): LocalBasis | null {
  const a = bodyAxes(bodyId, tMs);
  if (!a) return null;
  const b = enuBasis(latDeg * DEG, lonDeg * DEG);
  const w = (v: Vec3): V3 => [
    v[0] * a.ex[0] + v[1] * a.ey[0] + v[2] * a.ez[0],
    v[0] * a.ex[1] + v[1] * a.ey[1] + v[2] * a.ez[1],
    v[0] * a.ex[2] + v[1] * a.ey[2] + v[2] * a.ez[2],
  ];
  return { e: w(b.e), n: w(b.n), u: w(b.u) };
}

/** Unit vector from the site to a camera at azimuth `az` (from east toward north) and elevation `el` over the local horizon. */
export function localOffsetDir(b: LocalBasis, az: number, el: number): V3 {
  const ce = Math.cos(el), se = Math.sin(el), ca = Math.cos(az), sa = Math.sin(az);
  return [0, 1, 2].map((i) => ce * (ca * b.e[i] + sa * b.n[i]) + se * b.u[i]) as V3;
}

/** The inverse: azimuth and elevation of the direction `dir` in the local frame. */
export function localAngles(dir: V3, b: LocalBasis): { az: number; el: number } {
  const d = norm(dir);
  const x = d[0] * b.e[0] + d[1] * b.e[1] + d[2] * b.e[2], y = d[0] * b.n[0] + d[1] * b.n[1] + d[2] * b.n[2], z = d[0] * b.u[0] + d[1] * b.u[1] + d[2] * b.u[2];
  return { az: Math.atan2(y, x), el: Math.asin(Math.max(-1, Math.min(1, z))) };
}

/** Wait before the next ask for a traverse that is not there yet (404 until the server's first poll): 5 s, 15 s, 60 s, then every 5 min. */
export const traverseRetryMs = (attempt: number): number => [5_000, 15_000, 60_000][attempt] ?? 300_000;
