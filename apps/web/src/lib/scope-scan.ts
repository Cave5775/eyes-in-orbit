import { inView, type ScopeMode } from './scope';

/**
 * The scope scan as a plain loop over typed arrays (pure, no three.js): for each point it decides the `aShow` flag with
 * the policy of `lib/scope.ts` and tallies what is drawn for the HUD. `SceneController.refreshScope` calls it in slices
 * (a time slice per frame, `SCOPE_CHUNK` points per call) so the cost per frame no longer grows with the catalogue (docs/perf.md: 59 of 61 ms
 * of the main-thread draw at 100 k objects, 0.6 s at 1 M, when it was one pass over everything).
 *
 * What the old per-point loop paid for and this one does not: an id string hash lookup (`ctx.focus.has`) and three string
 * compares per point (the caller resolves the few special ids to a `special` byte array once, `markSpecials`), a
 * `THREE.Vector3` write, and the view/occlusion/disc tests for points that are already out of scope. The hierarchy decision
 * itself (`lib/scope.ts`) is resolved by the caller too: one flag for a whole set (`systemAll`: every SGP4 object is the
 * Earth's) or one byte per point (`system`).
 */

/** Points per `scanScope` call from the scene; the scene keeps calling it until its time slice for the frame is used up. */
export const SCOPE_CHUNK = 2048;

/** `special` bits: 1 = never scoped out (hovered, selected or related), 2 = exempt from the small-disc hiding (selected, hovered, followed). */
export const SPECIAL_KEEP = 1;
export const SPECIAL_EXEMPT = 2;

export interface ScopeScanInput {
  /** float64 world positions, xyz per point (Earth-fixed when `fixed`) */
  world: Float64Array;
  fixed: boolean;
  spinCos: number;
  spinSin: number;
  /** world translation of an inertial set (`RelPositions.shift`) */
  shift: readonly [number, number, number];
  /** camera-relative float32 copy the GPU draws (xyz per point) */
  rel: Float32Array;
  size: Float32Array;
  /** aShow per point; written in place */
  show: Float32Array;
  /** 1 where an active filter lets the point through (never scoped out, never hidden over a disc) */
  keep: Uint8Array | null;
  /** 1 = launch vehicle: exempt from disc hiding while in flight */
  exempt: Uint8Array | null;
  /** per point `SPECIAL_*` bits for the hovered / selected / followed / related ids */
  special: Uint8Array | null;
  /** per point: 1 = listed under a body in the scope (`scopeBodies`); null = the whole set is `systemAll` */
  system: Uint8Array | null;
  systemAll: boolean;
  mode: ScopeMode;
  /** projection * view, column-major 4x4 (three's `elements`) */
  m: ArrayLike<number>;
  occluded: (x: number, y: number, z: number) => boolean;
  discHidden: (x: number, y: number, z: number) => boolean;
  /** the aShow value of an exempt point (`SHOW_EXEMPT`) */
  showExempt: number;
  /** a launch vehicle is exempt above this distance from the Earth's centre, km */
  inFlightKm: number;
}

export interface ScopeScanResult {
  /** points with a position */
  total: number;
  /** in scope, not filtered out, in view, not behind a body */
  rendered: number;
  /** some aShow value changed (the attribute needs an upload) */
  changed: boolean;
}

/** Scan points `[from, to)`. */
export function scanScope(s: ScopeScanInput, from: number, to: number): ScopeScanResult {
  const { world, rel, size, show, keep, exempt, special, system, systemAll, m, showExempt } = s;
  const all = s.mode === 'all';
  const flightR2 = s.inFlightKm * s.inFlightKm;
  const cos = s.spinCos, sin = s.spinSin;
  const fixed = s.fixed;
  const sx = fixed ? 0 : s.shift[0], sy = fixed ? 0 : s.shift[1], sz = fixed ? 0 : s.shift[2];
  let total = 0, rendered = 0, changed = false;
  const end = Math.min(to, show.length, world.length / 3);
  for (let i = from; i < end; i++) {
    const j = i * 3;
    const px = world[j], py = world[j + 1], pz = world[j + 2];
    // no position (failed propagation, provider without a state)
    if (px === 0 && py === 0 && pz === 0) continue;
    let wx: number, wy: number, wz: number;
    if (fixed) {
      wx = cos * px - sin * py;
      wy = sin * px + cos * py;
      wz = pz;
    } else {
      wx = px + sx;
      wy = py + sy;
      wz = pz + sz;
    }
    total++;
    const sp = special === null ? 0 : special[i];
    const kept = keep !== null && keep[i] === 1;
    const inside = all || kept || (sp & SPECIAL_KEEP) !== 0 || (system === null ? systemAll : system[i] === 1);
    let v = 0;
    if (inside) {
      // an object the user filtered for is never hidden over a small disc, or a zoomed-out filter would show nothing
      const ex = (sp & SPECIAL_EXEMPT) !== 0 || kept || (exempt !== null && exempt[i] === 1 && wx * wx + wy * wy + wz * wz > flightR2);
      v = ex ? showExempt : 1;
    }
    if (show[i] !== v) {
      show[i] = v;
      changed = true;
    }
    if (v === 0 || size[i] <= 0) continue;
    const x = rel[j], y = rel[j + 1], z = rel[j + 2];
    if (!inView(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[3] * x + m[7] * y + m[11] * z + m[15])) continue;
    if (!s.occluded(x, y, z) && (v === showExempt || !s.discHidden(x, y, z))) rendered++;
  }
  return { total, rendered, changed };
}

/**
 * Fill `out[i]` with the `SPECIAL_*` bits of the points whose id is in `keepIds` (bit 1) or `exemptIds` (bit 2). A handful
 * of ids is resolved with `indexOf` (a tight native loop); a larger set (the selection plus many related objects) takes
 * one pass with a `Set`. Run when the ids change, not per scan.
 */
export function markSpecials(ids: readonly string[], out: Uint8Array, keepIds: Iterable<string>, exemptIds: readonly (string | null | undefined)[]): void {
  out.fill(0);
  const keep = new Set<string>();
  for (const k of keepIds) keep.add(k);
  const ex = new Set<string>();
  for (const e of exemptIds) if (e) ex.add(e);
  if (keep.size + ex.size === 0) return;
  if (keep.size <= 12 && ex.size <= 12) {
    for (const k of keep) {
      const i = ids.indexOf(k);
      if (i >= 0) out[i] |= SPECIAL_KEEP;
    }
    for (const e of ex) {
      const i = ids.indexOf(e);
      if (i >= 0) out[i] |= SPECIAL_EXEMPT;
    }
    return;
  }
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (keep.has(id)) out[i] |= SPECIAL_KEEP;
    if (ex.has(id)) out[i] |= SPECIAL_EXEMPT;
  }
}
