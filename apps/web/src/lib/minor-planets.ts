import {
  AU_KM, DEG, OBLIQUITY_J2000, SUN, angleFromCode, hFromCode, designationText, epochMsOfDay, ECC_SCALE,
  eclipticToEquatorial, keplerFromDegrees, precessDir, type KeplerElements, type UnpackedOrbits, type Vec3,
} from '@eio/core';

/**
 * Minor planets from the MPC (core `mpcorb.ts`): the pure parts of the point cloud. Propagation (float64, the same maths as core
 * `keplerState`), the spatial cells of the floating origin, level of detail, when to run again, and picking. The worker
 * (`workers/minor-planets.worker.ts`) calls `propagateBelt`; the scene (`scene/minor-planets.ts`) the rest.
 *
 * FLOATING ORIGIN. No absolute float32 position exists. A pass computes every position in float64 relative to the Sun (axes of
 * date: the ecliptic elements rotated by the obliquity of J2000 and by the precession of the date, exactly what `convert` does for
 * a heliocentric vector), bins the points into cubic cells and writes each as a float32 OFFSET from its cell's centre (the anchor,
 * float64). Every frame the CPU computes `anchor + Sun(now) - camera` per cell in float64 and uploads one 3-vector per cell; the
 * vertex shader adds the float32 offset. A point sits at `anchor + offset`: the rounding of the offset is half a float32 step at
 * the size of the offset, at most 0.5 cell edge per axis. A cell is 1 AU (1.496e8 km) wide inside 8 AU of the Sun: offsets stay
 * under 7.5e7 km, in [2^26, 2^27) where a float32 step is 8 km, so a point is within 4 km of the float64 position (`CELL_ERROR_KM`);
 * beyond 8 AU cells are 8 AU wide (offsets under 6e8 km, step 64 km, error 32 km, at 8 AU or more from the Sun where a pixel is
 * far larger). The uniform offset itself is rounded to float32 once per cell and frame (about 8 km for a cell 1 AU from the camera):
 * a whole cell can shift by that much against the camera, invisible unless the camera is within a few thousand km of a point.
 */

/** Cell edge inside `NEAR_LIMIT_KM` of the Sun, km. */
export const CELL_NEAR_KM = AU_KM;
/** Cell edge beyond it, km. */
export const CELL_FAR_KM = 8 * AU_KM;
export const NEAR_LIMIT_KM = 8 * AU_KM;
/** Worst error of a point from its offset's float32 rounding, km (half a step at 2^26..2^27 km). */
export const CELL_ERROR_KM = 4;
/**
 * Bound on the speed of a minor planet used by the drift rule, km/s: vis-viva at a perihelion of 0.15 AU is 104 km/s for a = 1 AU, the belt
 * moves 17-20 km/s and a near-Earth object up to 40. Sungrazers (q < 0.15 AU, a few hundred objects) are faster and lag by more than the
 * rule assumes between passes.
 */
export const MAX_SPEED_KM_S = 100;

const GM = SUN.gm;

// ------------------------------------------------------------------ propagation

/** Kepler's equation, the algorithm of core `kepler.ts` (`solveKepler`): start E = M (E = pi for e >= 0.8), Newton, 1e-12, at most 30 steps. */
export function solveKeplerE(m: number, e: number): number {
  const TWO_PI = Math.PI * 2;
  const r = m % TWO_PI;
  const M = r < 0 ? r + TWO_PI : r;
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 30; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** The 3x3 (row major) that takes a vector in the heliocentric ECLIPTIC axes of J2000 to the axes of date at `tMs`: obliquity, then precession. */
export function eclipticToDate(tMs: number): number[] {
  const cols = ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as Vec3[]).map((e) => precessDir(eclipticToEquatorial(e, OBLIQUITY_J2000), tMs, false));
  return [cols[0][0], cols[1][0], cols[2][0], cols[0][1], cols[1][1], cols[2][1], cols[0][2], cols[1][2], cols[2][2]];
}

/** One orbit's heliocentric position (km, axes of date) at `tMs`: same two-body maths as `keplerState`, ecliptic elements, `t` from `eclipticToDate`. */
export function orbitPosition(u: UnpackedOrbits, i: number, tMs: number, t: ArrayLike<number>, out: Vec3 = [0, 0, 0]): Vec3 {
  const a = u.a[i] * AU_KM, e = u.ecc[i] / ECC_SCALE;
  const n = Math.sqrt(GM / (a * a * a));
  const dt = (tMs - epochMsOfDay(u.epoch[i])) / 1000;
  const E = solveKeplerE(angleFromCode(u.m0[i]) * DEG + n * dt, e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const x = a * (cosE - e), y = a * Math.sqrt(1 - e * e) * sinE;
  const O = angleFromCode(u.node[i]) * DEG, I = angleFromCode(u.inc[i]) * DEG, w = angleFromCode(u.argp[i]) * DEG;
  const cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(I), si = Math.sin(I), cw = Math.cos(w), sw = Math.sin(w);
  // perifocal -> ecliptic: Rz(-O) Rx(-i) Rz(-w), as in keplerState
  const ex = (cO * cw - sO * sw * ci) * x + (-cO * sw - sO * cw * ci) * y;
  const ey = (sO * cw + cO * sw * ci) * x + (-sO * sw + cO * cw * ci) * y;
  const ez = sw * si * x + cw * si * y;
  out[0] = t[0] * ex + t[1] * ey + t[2] * ez;
  out[1] = t[3] * ex + t[4] * ey + t[5] * ez;
  out[2] = t[6] * ex + t[7] * ey + t[8] * ez;
  return out;
}

/** A cell: its anchor (centre, heliocentric km, axes of date, float64), the slice of the output it owns and a bounding sphere. */
export interface BeltCell {
  ax: number;
  ay: number;
  az: number;
  /** first slot and number of points; the points are in file order, i.e. brightest (smallest H) first */
  start: number;
  count: number;
  /** radius of the sphere that holds the cell, km */
  radiusKm: number;
}

export interface BeltResult {
  /** the sim time the positions are for */
  simMs: number;
  cells: BeltCell[];
  /** float32 offsets from each point's cell anchor, xyz per slot, cells contiguous */
  offsets: Float32Array;
  /** H of each slot, hundredths from -10 (65535 unknown) */
  h: Uint16Array;
  /** orbit index (over all the chunks, in file order) of each slot */
  index: Uint32Array;
  /**
   * cell number of each slot (the vertex attribute: the shader looks the cell's offset up in a texture). FLOAT32, not Uint32: three.js binds a
   * 32-bit integer array with `vertexAttribIPointer`, and a shader that declares `attribute float` over it reads garbage (every point took cell
   * 0's texel and was dropped: the cloud never showed). A float32 holds every cell number exactly (below 2^24).
   */
  cell: Float32Array;
  /** how long the pass took, ms */
  ms: number;
}

const KEY = 4096;
const cellKey = (level: number, ix: number, iy: number, iz: number): number =>
  ((level * KEY + (ix + 2048)) * KEY + (iy + 2048)) * KEY + (iz + 2048);

/**
 * Propagate every orbit of `chunks` (concatenated in order) to `tMs`, bin the points into cells and write the float32 offsets.
 * Float64 throughout; the scratch positions (24 bytes a point) live only inside the pass.
 */
export function propagateBelt(chunks: readonly UnpackedOrbits[], tMs: number): BeltResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  let n = 0;
  for (const c of chunks) n += c.count;
  const t = eclipticToDate(tMs);
  const pos = new Float64Array(n * 3);
  const cellOf = new Int32Array(n);
  const ids = new Map<number, number>();
  const anchors: number[] = [];
  const sizes: number[] = [];
  const counts: number[] = [];
  const p: Vec3 = [0, 0, 0];
  let k = 0;
  for (const u of chunks) {
    for (let i = 0; i < u.count; i++, k++) {
      orbitPosition(u, i, tMs, t, p);
      pos[k * 3] = p[0]; pos[k * 3 + 1] = p[1]; pos[k * 3 + 2] = p[2];
      const far = Math.hypot(p[0], p[1], p[2]) >= NEAR_LIMIT_KM;
      const size = far ? CELL_FAR_KM : CELL_NEAR_KM;
      const ix = Math.max(-2048, Math.min(2047, Math.floor(p[0] / size))), iy = Math.max(-2048, Math.min(2047, Math.floor(p[1] / size))), iz = Math.max(-2048, Math.min(2047, Math.floor(p[2] / size)));
      const key = cellKey(far ? 1 : 0, ix, iy, iz);
      let c = ids.get(key);
      if (c === undefined) {
        c = counts.length;
        ids.set(key, c);
        anchors.push((ix + 0.5) * size, (iy + 0.5) * size, (iz + 0.5) * size);
        sizes.push(size);
        counts.push(0);
      }
      cellOf[k] = c;
      counts[c]++;
    }
  }
  const cells: BeltCell[] = [];
  const next = new Int32Array(counts.length);
  let at = 0;
  for (let c = 0; c < counts.length; c++) {
    cells.push({ ax: anchors[c * 3], ay: anchors[c * 3 + 1], az: anchors[c * 3 + 2], start: at, count: counts[c], radiusKm: sizes[c] * Math.sqrt(3) / 2 });
    next[c] = at;
    at += counts[c];
  }
  const offsets = new Float32Array(n * 3), h = new Uint16Array(n), index = new Uint32Array(n), cell = new Float32Array(n);
  k = 0;
  for (const u of chunks) {
    for (let i = 0; i < u.count; i++, k++) {
      const c = cellOf[k], s = next[c]++;
      offsets[s * 3] = pos[k * 3] - anchors[c * 3];
      offsets[s * 3 + 1] = pos[k * 3 + 1] - anchors[c * 3 + 1];
      offsets[s * 3 + 2] = pos[k * 3 + 2] - anchors[c * 3 + 2];
      h[s] = u.h[i];
      index[s] = k;
      cell[s] = c;
    }
  }
  return { simMs: tMs, cells, offsets, h, index, cell, ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 };
}

// ------------------------------------------------------------------ level of detail and culling

/** Points drawn per square screen pixel at most: one in 16 (a 4 x 4 block), so a zoomed-out belt does not become a grey band. */
export const POINTS_PER_PX2 = 1 / 16;

/**
 * How many of a cell's points (the brightest first) to draw. Camera inside the cell's sphere: all. Otherwise the cell's disc on the
 * screen holds at most `POINTS_PER_PX2` points per pixel; `pxPerRad` is the viewport height over 2 tan(fov / 2).
 */
export function cellDrawCount(count: number, radiusKm: number, distKm: number, pxPerRad: number): number {
  if (distKm <= radiusKm) return count;
  const pxRadius = Math.asin(radiusKm / distKm) * pxPerRad;
  return Math.min(count, Math.ceil(Math.PI * pxRadius * pxRadius * POINTS_PER_PX2));
}

/** Is a sphere (camera-relative centre, radius) inside the view cone of half-angle `halfRad` around the unit `dir`? Conservative. */
export function sphereInCone(rel: Vec3, radiusKm: number, dir: Vec3, halfRad: number): boolean {
  const d = Math.hypot(rel[0], rel[1], rel[2]);
  if (d <= radiusKm) return true;
  const cos = (rel[0] * dir[0] + rel[1] * dir[1] + rel[2] * dir[2]) / d;
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= halfRad + Math.asin(radiusKm / d);
}

// ------------------------------------------------------------------ when to run again

/** The shortest gap between a pass's end and the next one's start, ms (a seek or a new chunk). */
export const MIN_RERUN_MS = 1500;
/** The shortest gap between two DRIFT passes, ms: a pass costs a second of worker time, about 60 MB of allocations, a 25 MB transfer and a 22 MB GPU upload. */
export const MIN_DRIFT_RERUN_MS = 20_000;
/** A pass is not started again before this many times its own duration has passed (a slow machine passes less often). */
export const COST_FACTOR = 15;
/** A change of sim time larger than this (a seek, a rate change that moved the clock far) reruns without waiting for the drift gap. */
export const JUMP_MS = 24 * 3600_000;
/** Allowed drift, screen pixels: positions older than this many pixels of motion at the nearest drawn points are replaced. */
export const DRIFT_PX = 0.5;

/**
 * Distance to the nearest point when the camera is INSIDE a populated cell (so the cell's own surface says nothing): the expected
 * nearest-neighbour distance of `count` points spread over a cube of edge `edgeKm`, 0.55 (V / n)^(1/3). 1 AU cell with 50,000 points: 2e6 km.
 */
export function insideNearestKm(count: number, edgeKm: number): number {
  return 0.55 * Math.cbrt((edgeKm * edgeKm * edgeKm) / Math.max(1, count));
}

export interface RerunInput {
  /** sim time now, and the time of the positions on show (null: none yet or new orbits arrived) */
  simMs: number;
  atMs: number | null;
  /** distance from the camera to the nearest drawn points, km (`cellNearestKm` over the drawn cells, floored by the caller) */
  nearestKm: number;
  fovRad: number;
  viewportPx: number;
  /** wall time since the last pass ended, ms, and how long that pass took, ms */
  sinceLastMs: number;
  lastPassMs: number;
  running: boolean;
}

/**
 * Does the cloud need a new pass? Only when it is wrong by a visible amount: a minor planet moves at most `MAX_SPEED_KM_S`, so the
 * positions are `|dt| * v` km off; that is compared with half a pixel at the nearest drawn points. Never closer than
 * `max(MIN_DRIFT_RERUN_MS, COST_FACTOR * lastPassMs)` after the last pass (the cost of a pass: a second of worker time, 60 MB allocated, 25 MB moved, 22 MB uploaded):
 * with nothing within 1e8 km (a pixel of 1e5 km) a pass is due every 8 minutes at 1x, with the camera inside a belt cell (the nearest points
 * 2e6 km away, a pixel of 2e3 km) every 20 s, the floor. A jump of the clock (more than a day) skips the drift gap but still waits
 * `max(MIN_RERUN_MS, 3 * lastPassMs)`, so a clock running a day per second does not chain passes back to back; new orbits (`atMs` null) wait
 * `max(MIN_RERUN_MS, 2 * lastPassMs)`.
 */
export function rerunDue(i: RerunInput): 'first' | 'jump' | 'drift' | null {
  if (i.running) return null;
  if (i.atMs === null) return i.sinceLastMs >= Math.max(MIN_RERUN_MS, 2 * i.lastPassMs) ? 'first' : null;
  const dt = Math.abs(i.simMs - i.atMs);
  if (dt === 0) return null;
  if (dt > JUMP_MS) return i.sinceLastMs >= Math.max(MIN_RERUN_MS, 3 * i.lastPassMs) ? 'jump' : null;
  if (i.sinceLastMs < Math.max(MIN_DRIFT_RERUN_MS, COST_FACTOR * i.lastPassMs)) return null;
  const pixelKm = (i.nearestKm * i.fovRad) / Math.max(1, i.viewportPx);
  return (dt / 1000) * MAX_SPEED_KM_S > DRIFT_PX * pixelKm ? 'drift' : null;
}

/**
 * What a pass that has just finished leaves as the time of the positions on show: its own time, unless orbits were handed to the worker
 * after the pass began (`total` < `loaded`): those are not in it, so `null` makes the next frame ask for a pass that has them.
 */
export const shownAtMs = (simMs: number, total: number, loaded: number): number | null => (total >= loaded ? simMs : null);


// ------------------------------------------------------------------ picking

export interface BeltPickInput {
  cells: readonly BeltCell[];
  offsets: Float32Array;
  /** per cell: how many points are drawn (`cellDrawCount`, 0 hidden) */
  drawn: ArrayLike<number>;
  /** per cell: anchor + Sun(now) - camera, float64 (what the frame uploads) */
  rel: ArrayLike<number>;
  /** unit ray direction through the cursor, camera-relative */
  dir: Vec3;
  /** tangent of the pick radius around the ray (pixels over `pxPerRad`) */
  tan: number;
  /** true when a drawn body hides the camera-relative point (the shared occlusion rule) */
  hidden?: (x: number, y: number, z: number) => boolean;
}

/**
 * The drawn point nearest to the pick ray (smallest angle, within `tan`), as its slot, or -1. The cells are the grid: a cell whose
 * sphere the pick cone misses is skipped whole, the others are scanned point by point (the brightest `drawn` of them, the ones on screen).
 */
export function pickBelt(i: BeltPickInput): { slot: number; angle: number } {
  let best = -1, bestAngle = i.tan;
  const [dx, dy, dz] = i.dir;
  for (let c = 0; c < i.cells.length; c++) {
    const cell = i.cells[c], drawn = i.drawn[c];
    if (!drawn) continue;
    const cx = i.rel[c * 3], cy = i.rel[c * 3 + 1], cz = i.rel[c * 3 + 2];
    const dist = Math.hypot(cx, cy, cz);
    if (dist > cell.radiusKm) {
      const along = cx * dx + cy * dy + cz * dz;
      if (along <= -cell.radiusKm) continue;
      const miss = along > 0 ? Math.sqrt(Math.max(0, dist * dist - along * along)) : dist;
      if (miss > cell.radiusKm + i.tan * (along + cell.radiusKm) + 1) continue;
    }
    const end = cell.start + drawn;
    for (let s = cell.start; s < end; s++) {
      const x = cx + i.offsets[s * 3], y = cy + i.offsets[s * 3 + 1], z = cz + i.offsets[s * 3 + 2];
      const along = x * dx + y * dy + z * dz;
      if (along <= 0) continue;
      const perp = Math.sqrt(Math.max(0, x * x + y * y + z * z - along * along));
      const ang = perp / along;
      if (ang < bestAngle && !(i.hidden && i.hidden(x, y, z))) {
        bestAngle = ang;
        best = s;
      }
    }
  }
  return { slot: best, angle: best < 0 ? Infinity : bestAngle };
}

// ------------------------------------------------------------------ the picked point as an entity

export interface PickedOrbit {
  designation: string;
  h: number | null;
  epochMs: number;
  elements: KeplerElements;
}

/** Everything about orbit `i` of a container that the synthetic entity needs, in the equatorial J2000 axes of `SUN:inertial`. */
export function pickedOrbit(u: UnpackedOrbits, i: number): PickedOrbit {
  const epochMs = epochMsOfDay(u.epoch[i]);
  return {
    designation: designationText(u.desig[i]), h: hFromCode(u.h[i]), epochMs,
    elements: keplerFromDegrees(u.a[i], u.ecc[i] / ECC_SCALE, angleFromCode(u.inc[i]), angleFromCode(u.node[i]), angleFromCode(u.argp[i]), angleFromCode(u.m0[i]), epochMs),
  };
}

/** Size in pixels and alpha of a point from its H: bright ones (H <= 9) 2 px, faint ones (H >= 20) 1 px, linear between; alpha 1 to 0.35. */
export function pointLook(hCode: number): { px: number; alpha: number } {
  if (hCode === 65535) return { px: 1, alpha: 0.35 };
  const h = hCode / 100 - 10;
  const f = Math.max(0, Math.min(1, (h - 9) / 11));
  return { px: 2 - f, alpha: 1 - 0.65 * f };
}
