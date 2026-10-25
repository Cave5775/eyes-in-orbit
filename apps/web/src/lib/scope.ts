/**
 * Scope policy (pure): which objects are worth drawing for the current focus. The scene draws everything it knows about
 * by default; once the camera is close to something, thousands of satellites hundreds of kilometres overhead and probes
 * millions of kilometres away are clutter, cost vertex work and can be hovered by accident.
 *
 * The focus is the camera target (the followed object, the surface point, or the Earth's centre in a globe view) and
 * the camera-to-target distance sets the scale: an object is in scope when it is within `SCOPE_FACTOR` camera distances
 * of the focus. Examples: hovering 4 km over a pad keeps ~320 km around it (the pad, a booster, the DSN station next
 * door; not the 12,000 satellites or any probe); the default Earth view (24,000 km) keeps ~1.9 million km (JWST at
 * 1.5 million km; the deep-space shell appears once the camera pulls out a little); a view that frames the whole
 * shell keeps everything.
 *
 * Beyond the scope radius the satellite cloud is thinned out over one more radius instead of being cut at an edge
 * (a stable pseudo-random subset, so the sky does not shimmer while zooming); individual entities (probes, stations,
 * pads) are cut at 1.5 radii. Whatever the policy, the caller always keeps the selection, its related objects, the
 * hovered object, and (while the search has an only or text term) the objects it lets through.
 *
 * Horizon culling is separate and exact (`lib/occlusion.ts`, also done in the point shader): this module only decides
 * by distance from the focus. All distances in km.
 */

export type ScopeMode = 'auto' | 'all';

/** Camera distances kept around the focus. */
export const SCOPE_FACTOR = 80;
/** Never scope tighter than this (a camera 1 km from a booster still shows the pad complex around it). */
export const SCOPE_MIN_KM = 100;
/** Entities that are not part of a cloud are cut at this multiple of the scope radius. */
export const SCOPE_SOLO_CUT = 1.5;

/** Scope radius for a camera `distKm` from its target. */
export function scopeRadius(distKm: number): number {
  return Math.max(SCOPE_MIN_KM, SCOPE_FACTOR * Math.max(0, distKm));
}

/** Keep probability of a cloud member at distance `d` from the focus: 1 inside the radius, linear to 0 at twice the radius. */
export function scopeWeight(d: number, radiusKm: number): number {
  if (d <= radiusKm) return 1;
  if (d >= 2 * radiusKm) return 0;
  return (2 * radiusKm - d) / radiusKm;
}

/** Stable pseudo-random number in [0, 1) from an integer (an index into the cloud), so thinning is the same every frame. */
export function hash01(i: number): number {
  let x = (i | 0) + 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export interface ScopeObject {
  /** distance from the focus point, km */
  d: number;
  /** stable index (cloud member number), used to thin clouds */
  key: number;
  /** member of a bulk cloud (the SGP4 catalogue): thinned rather than cut */
  bulk: boolean;
  /** selected, related, hovered or let through by the search: never culled */
  keep: boolean;
  /** entity kind; celestial bodies (see `SCOPE_EXEMPT_KINDS`) are never thinned or cut */
  kind?: string;
}

/**
 * Kinds that are exempt from scope culling and thinning: the celestial bodies (stars, planets, moons). They are drawn
 * by the scene itself rather than as points, so they are not in the point sets either; this keeps a body from being
 * dropped should it ever be passed through the policy (the Sun is 1.5e8 km from the Earth, Mars further).
 */
export const SCOPE_EXEMPT_KINDS: ReadonlySet<string> = new Set(['star', 'planet', 'moon']);

export const isScopeExempt = (kind: string | undefined): boolean => kind !== undefined && SCOPE_EXEMPT_KINDS.has(kind);

/** Is the object inside the scope? `mode: 'all'` keeps everything (horizon and filters still apply elsewhere). */
export function inScope(o: ScopeObject, radiusKm: number, mode: ScopeMode = 'auto'): boolean {
  if (mode === 'all' || o.keep || isScopeExempt(o.kind)) return true;
  if (o.bulk) return hash01(o.key) < scopeWeight(o.d, radiusKm);
  return o.d <= radiusKm * SCOPE_SOLO_CUT;
}

/** Pixel-space margin (fraction of the half-extent) beyond the screen edge that still counts as "in view" for the HUD tally. */
export const VIEW_MARGIN = 1.05;

/**
 * Counts for the HUD: what is drawn out of everything known. `total` counts objects with a position; `rendered` those that
 * are in scope, not filtered out, not behind the Earth and inside the view.
 */
export interface ScopeCounts {
  total: number;
  rendered: number;
}

/** Is a clip-space point (x, y, w) inside the view, with a small margin? w <= 0 is behind the camera. */
export function inView(cx: number, cy: number, cw: number, margin = VIEW_MARGIN): boolean {
  return cw > 0 && Math.abs(cx) <= cw * margin && Math.abs(cy) <= cw * margin;
}
