/**
 * Screen-space picking, split from three.js so it can be tested: given the point sets (camera-relative positions, sizes,
 * show flags) and a projection * view matrix, list every visible object near a screen point: highest in the hierarchy
 * first, then the most recently created, then the nearest to the cursor. Zoomed out, objects over a small distant body are
 * not drawn and not candidates (`PickOptions.discHidden`, lib/disc-hide.ts), so a click there finds the body (`resolvePick`).
 *
 * One scan serves the callers so they cannot disagree: a plain click takes the first entry and a click with more than one
 * entry opens the choice popup (ui/PickPopup.tsx) with the whole list; hover asks for `nearestFirst` so the tooltip names
 * the object under the pointer rather than the newest one near it.
 */
import { entityRank, type BodyRegistry, type EntityRecord } from '@eio/core';

/** Everything whose centre is within this many CSS px of the cursor is a candidate (a point's own hit radius may be larger). */
export const CLUSTER_PX = 10;
/** Floor of a point's own hit radius, px (the radius is `max(MIN_HIT_PX, size / 2 + 4)`). */
export const MIN_HIT_PX = 6.05;
/** Rows the choice popup lists. */
export const POPUP_MAX = 12;
/** `show` value (the shader's `aShow`) of a point that is drawn whatever lies under it: exempt from `PickOptions.discHidden`. */
export const SHOW_EXEMPT = 2;
/** The shader treats `aShow >= SHOW_EXEMPT_MIN` as exempt (a float compare with room for rounding). */
export const SHOW_EXEMPT_MIN = 1.5;

export interface PickSource {
  ids: readonly string[];
  /** camera-relative xyz, 3 per point (what the GPU gets) */
  rel: ArrayLike<number>;
  /** world xyz, 3 per point; an all-zero triple means "no position" */
  world: ArrayLike<number>;
  /** point size in px; 0 = not drawn */
  size: ArrayLike<number>;
  /** 0 = scoped out, 1 = drawn, `SHOW_EXEMPT` (2) = drawn and never hidden over a small body's disc */
  show: ArrayLike<number>;
  /** squared px subtracted from the distance when ranking, so a propagated object beats a cloud point on a near tie */
  bias: number;
  /** hierarchy rank per point (`entityRank`, smaller = listed first); a point without one ranks last */
  rank?: ArrayLike<number>;
}

/** A candidate that is not in a point set (a drawn 3D model, the selected object's highlight, a drawn body). */
export interface PickExtra {
  id: string;
  /** squared px from the cursor, used for ranking */
  d2: number;
  /** camera-relative position; when given, an object behind the Earth (or the Moon, the Sun) is dropped */
  rel?: readonly [number, number, number];
  /** hierarchy rank (`entityRank`, smaller = listed first); missing ranks last */
  rank?: number;
  /** a drawn body: the projected radius of its disc, px (see `bodyDiscRadiusPx`) */
  discPx?: number;
  /** ms the entity was created (newer first among equal ranks); missing = oldest */
  created?: number;
}

/** Rank of a candidate without one: after every body and every object ranked by `entityRank` (those are below 2e6). */
export const DEFAULT_RANK = 1e9;

export interface PickHit {
  id: string;
  /** px from the cursor */
  dist: number;
  /** a drawn body: the projected radius of its disc, px */
  discPx?: number;
}

export interface PickOptions {
  /** most entries to return */
  max: number;
  /** keep counting past `max` so `total` is exact (the popup's "+ n more"); without it the scan stops at `max` */
  wantTotal?: boolean;
  clusterPx?: number;
  /** is the camera-relative point hidden behind a body? */
  occluded: (x: number, y: number, z: number) => boolean;
  /**
   * is the camera-relative point not drawn because it is over a small, far body's disc (`hiddenByDisc`)? Asked only of
   * points of the sources whose `show` is below `SHOW_EXEMPT_MIN`; extras (models, the selection) are never asked.
   */
  discHidden?: (x: number, y: number, z: number) => boolean;
  /** hierarchy rank by entity id for points and extras that carry none of their own (see `rankMap`) */
  ranks?: ReadonlyMap<string, number>;
  /** creation time by entity id (see `pickMeta`): among equal ranks the newest is listed first, before distance */
  created?: ReadonlyMap<string, number>;
  /** list purely by distance to the cursor (hover: the object under the pointer, not the newest one near it) */
  nearestFirst?: boolean;
  /**
   * the discs of the drawn bodies that hold the cursor (`bodyPickScan`): a point (or an extra with a position) whose centre is
   * not inside one of them is not a candidate, so an object beside a planet cannot take a click aimed at the planet's disc.
   * Empty or absent: no restriction.
   */
  covers?: readonly CoverDisc[];
}

/** A drawn body's disc on screen, CSS px (see `pickPrecedence`). */
export interface CoverDisc {
  sx: number;
  sy: number;
  r: number;
}

/** Is the screen point inside one of the discs? */
export function inCover(covers: readonly CoverDisc[], sx: number, sy: number): boolean {
  for (const c of covers) if (Math.hypot(sx - c.sx, sy - c.sy) <= c.r) return true;
  return false;
}

interface Raw {
  /** hierarchy rank: candidates sort by it first */
  hier: number;
  /** creation time, ms: newest first among equal ranks */
  created: number;
  discPx?: number;
  rank: number;
  d2: number;
  id: string;
  x: number;
  y: number;
  z: number;
  checkOcc: boolean;
}

/**
 * @param m column-major projection * view matrix (three's `.elements`)
 * @param w, h viewport size in CSS px
 * @param px, py the cursor in CSS px from the viewport's top-left
 * @returns visible candidates nearest first, de-duplicated by id, capped to `opts.max`; `total` counts all of them when
 *   `wantTotal` is set
 */
export function gatherCandidates(
  sources: readonly PickSource[],
  extras: readonly PickExtra[],
  m: ArrayLike<number>,
  w: number,
  h: number,
  px: number,
  py: number,
  opts: PickOptions,
): { items: PickHit[]; total: number } {
  const cluster = opts.clusterPx ?? CLUSTER_PX;
  const raws: Raw[] = [];
  for (const src of sources) {
    const { ids, rel, world, size, show } = src;
    for (let i = 0; i < ids.length; i++) {
      if (size[i] === 0 || show[i] === 0) continue;
      if (world[i * 3] === 0 && world[i * 3 + 1] === 0 && world[i * 3 + 2] === 0) continue;
      const x = rel[i * 3], y = rel[i * 3 + 1], z = rel[i * 3 + 2];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 0) continue;
      const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * w;
      const sy = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5 + 0.5)) * h;
      const dx = sx - px, dy = sy - py;
      const r = Math.max(cluster, MIN_HIT_PX, size[i] * 0.5 + 4);
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r) {
        if (opts.covers?.length && !inCover(opts.covers, sx, sy)) continue; // beside the body whose disc holds the cursor
        if (opts.discHidden && show[i] < SHOW_EXEMPT_MIN && opts.discHidden(x, y, z)) continue;
        const hier = src.rank?.[i] ?? opts.ranks?.get(ids[i]) ?? DEFAULT_RANK;
        raws.push({ hier, created: opts.created?.get(ids[i]) ?? 0, rank: d2 - src.bias, d2, id: ids[i], x, y, z, checkOcc: true });
      }
    }
  }
  for (const e of extras) {
    if (opts.covers?.length && e.rel) {
      const [x, y, z] = e.rel;
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw > 0 && !inCover(opts.covers, ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * w, (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5 + 0.5)) * h)) continue;
    }
    const hier = e.rank ?? opts.ranks?.get(e.id) ?? DEFAULT_RANK;
    raws.push({
      hier, created: e.created ?? opts.created?.get(e.id) ?? 0, discPx: e.discPx, rank: e.d2, d2: e.d2, id: e.id,
      x: e.rel?.[0] ?? 0, y: e.rel?.[1] ?? 0, z: e.rel?.[2] ?? 0, checkOcc: !!e.rel,
    });
  }
  // highest in the hierarchy first, then the most recently created, then the nearest to the cursor
  if (opts.nearestFirst) raws.sort((a, b) => a.rank - b.rank);
  else raws.sort((a, b) => a.hier - b.hier || Math.min(b.discPx ?? 0, 1e9) - Math.min(a.discPx ?? 0, 1e9) || b.created - a.created || a.rank - b.rank);

  const items: PickHit[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const r of raws) {
    if (seen.has(r.id)) continue;
    if (r.checkOcc && opts.occluded(r.x, r.y, r.z)) continue;
    seen.add(r.id);
    total++;
    if (items.length < opts.max) items.push(r.discPx === undefined ? { id: r.id, dist: Math.sqrt(r.d2) } : { id: r.id, dist: Math.sqrt(r.d2), discPx: r.discPx });
    else if (!opts.wantTotal) break;
  }
  return { items, total };
}

/** Smallest pick radius of a drawn body, px (a far-away Moon or Mars is a dot a few px wide but must be easy to hit). */
export const BODY_MIN_HIT_PX = 14;

/**
 * Pick radius (CSS px) of a drawn body: the projected radius of its disc plus 3 px, never below `minPx`. `radiusKm` is the
 * true radius and `k` the display shrink factor (see `refDisplay`; 1 when nothing is compressed), so `radiusKm * k` is
 * the radius that is drawn; `distKm` the distance from the camera to the body's centre in display space; `fovDeg` the
 * vertical field of view and `viewportPx` the viewport height. Inside the sphere the disc covers the view.
 */
export function bodyHitRadiusPx(radiusKm: number, k: number, distKm: number, fovDeg: number, viewportPx: number, minPx = BODY_MIN_HIT_PX): number {
  const disc = bodyDiscRadiusPx(radiusKm, k, distKm, fovDeg, viewportPx);
  return disc === Infinity ? Math.max(minPx, viewportPx) : Math.max(minPx, disc + 3);
}

/** Projected radius (CSS px) of a body's disc: `bodyHitRadiusPx` without the margin and the floor. Infinity inside the sphere. */
export function bodyDiscRadiusPx(radiusKm: number, k: number, distKm: number, fovDeg: number, viewportPx: number): number {
  const r = radiusKm * k;
  if (!(distKm > r)) return Infinity;
  const focalPx = viewportPx / (2 * Math.tan((fovDeg * Math.PI) / 360));
  // tangent half-angle of the silhouette: r / sqrt(d^2 - r^2)
  return (r / Math.sqrt(distKm * distKm - r * r)) * focalPx;
}

export interface BodyPickInput {
  id: string;
  /** camera-relative position of the body's centre in display space, km */
  rel: readonly [number, number, number];
  radiusKm: number;
  /** display shrink factor of the radius (1: true scale) */
  k: number;
  fovDeg: number;
  /** column-major projection * view matrix and viewport size in CSS px (as for `gatherCandidates`) */
  m: ArrayLike<number>;
  w: number;
  h: number;
  /** the cursor in CSS px from the viewport's top-left */
  px: number;
  py: number;
  /** hierarchy rank (`entityRank`) */
  rank?: number;
  minPx?: number;
  /** drop it when it is behind another body (the Moon behind the Earth); the Earth itself is not checked against itself */
  checkOcclusion?: boolean;
}

/** Radius of the marker a body keeps however small its disc is, px: where a body in front of a larger one can still be hit. */
export const BODY_MARKER_PX = 5;

/** A drawn body measured against the cursor (`probeBody`): the input of `pickPrecedence`. */
export interface BodyProbe {
  id: string;
  /** squared px from the cursor to the disc's centre */
  d2: number;
  /** screen position of the centre, px */
  sx: number;
  sy: number;
  /** distance from the camera to the centre (any unit, only compared) */
  dist: number;
  /** projected radius of the disc, px (Infinity inside the sphere) */
  discPx: number;
  /** extended hit radius, px (`bodyHitRadiusPx`) */
  hitPx: number;
  rel: readonly [number, number, number];
  rank?: number;
  checkOcclusion?: boolean;
}

/** Measures a drawn body against the cursor; null when it is behind the camera. No hit test: see `pickPrecedence`. */
export function probeBody(b: BodyPickInput): BodyProbe | null {
  const [x, y, z] = b.rel;
  const m = b.m;
  const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (cw <= 0) return null;
  const sx = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / cw * 0.5 + 0.5) * b.w;
  const sy = (1 - ((m[1] * x + m[5] * y + m[9] * z + m[13]) / cw * 0.5 + 0.5)) * b.h;
  const dx = sx - b.px, dy = sy - b.py;
  const dist = Math.hypot(x, y, z);
  const p: BodyProbe = {
    id: b.id, d2: dx * dx + dy * dy, sx, sy, dist, rel: [x, y, z],
    discPx: bodyDiscRadiusPx(b.radiusKm, b.k, dist, b.fovDeg, b.h),
    hitPx: bodyHitRadiusPx(b.radiusKm, b.k, dist, b.fovDeg, b.h, b.minPx),
  };
  if (b.rank !== undefined) p.rank = b.rank;
  if (b.checkOcclusion) p.checkOcclusion = true;
  return p;
}

/** The pick extra of a probed body. */
export function probeExtra(p: BodyProbe): PickExtra {
  const extra: PickExtra = { id: p.id, d2: p.d2, discPx: p.discPx };
  if (p.rank !== undefined) extra.rank = p.rank;
  if (p.checkOcclusion) extra.rel = [p.rel[0], p.rel[1], p.rel[2]];
  return extra;
}

/**
 * The pick extra for a drawn body (Earth, Moon, Sun, Mars), or null when the cursor is not on it or it is behind the
 * camera. `d2` is the squared px distance from the cursor to the disc's centre; the hit area is `bodyHitRadiusPx`. One body
 * on its own: with several, `pickPrecedence` decides which hit areas count.
 */
export function bodyPickExtra(b: BodyPickInput): PickExtra | null {
  const p = probeBody(b);
  return p && p.d2 <= p.hitPx * p.hitPx ? probeExtra(p) : null;
}

/**
 * THE precedence rule between drawn bodies under one cursor, for picks and hover (the labels' twin is
 * `LabelPlanner`'s disc test, lib/labels.ts):
 *
 * - the cursor inside a body's disc (its marker, `BODY_MARKER_PX`, when the disc is smaller) belongs to that body, unless
 *   another body whose disc also holds the cursor is nearer the camera and at least as big (it covers it). A smaller body in
 *   front of a larger one keeps its hit, and then both are listed (the choice popup, larger first);
 * - the extended hit area of a body (14 px minimum, disc + 3 px) applies only where no body's disc holds the cursor: a moon's
 *   margin never takes a click from inside its planet's disc, and the planet's own 3 px margin does not take one from a
 *   moon beside its limb.
 *
 * Returns the bodies hit (input order) and the discs of those that hold the cursor (`PickOptions.covers`): objects beside
 * them are not candidates there. Occlusion by other bodies is the caller's (a body behind another is not passed in).
 */
export function pickPrecedence(probes: readonly BodyProbe[]): { hits: BodyProbe[]; covers: CoverDisc[] } {
  const core = (p: BodyProbe) => Math.max(p.discPx, BODY_MARKER_PX);
  const holding = probes.filter((p) => p.d2 <= core(p) ** 2);
  const hits: BodyProbe[] = [];
  const covers: CoverDisc[] = [];
  for (const p of probes) {
    if (holding.length === 0) {
      if (p.d2 <= p.hitPx * p.hitPx) hits.push(p);
      continue;
    }
    if (!holding.includes(p)) continue;
    if (holding.some((o) => o !== p && o.dist < p.dist && core(o) >= core(p))) continue; // covered by a nearer, larger disc
    hits.push(p);
    if (p.d2 <= p.discPx * p.discPx) covers.push({ sx: p.sx, sy: p.sy, r: p.discPx });
  }
  return { hits, covers };
}

/** Hierarchy rank of every entity by id (core `entityRank`), computed once per catalog change for `PickOptions.ranks`. */
export function rankMap(entities: Iterable<Pick<EntityRecord, 'id' | 'provider' | 'bodyId'>>, registry?: BodyRegistry): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of entities) out.set(e.id, entityRank(e, registry));
  return out;
}

/** Hierarchy rank and creation time of every entity by id, for `PickOptions.ranks` and `.created`; built once per catalog change. */
export function pickMeta(
  entities: Iterable<Pick<EntityRecord, 'id' | 'provider' | 'bodyId' | 'createdAt' | 'updatedAt'>>,
  registry?: BodyRegistry,
): { ranks: Map<string, number>; created: Map<string, number> } {
  const ranks = new Map<string, number>(), created = new Map<string, number>();
  for (const e of entities) {
    ranks.set(e.id, entityRank(e, registry));
    created.set(e.id, e.createdAt ?? e.updatedAt);
  }
  return { ranks, created };
}

/**
 * Zoomed-out hiding: a body whose disc is at most this many px in radius (an Earth about 80 px across or smaller) is
 * "far away", and the objects over it (inside its pick hit area, and the Earth's low-orbit shell) are not drawn and not pickable
 * (lib/disc-hide.ts): a click there selects the body. Bigger than that the objects are drawn apart enough to aim at.
 */
export const GROUP_DISC_PX = 40;

export interface PickResolution {
  /** what the click lists, primary entry first (hierarchy order: bodies, then objects by rank and recency) */
  items: PickHit[];
  /** candidates counted, `items` may be capped */
  total: number;
}

/**
 * Decides what a click on `objects` (visible objects under the cursor, hierarchy ordered; the ones hidden over a small body
 * are not among them) and `bodies` (drawn bodies whose hit area holds the cursor) lists:
 *
 * - any object: the objects only. A body is never listed beside objects, because the Earth's disc covers most of the screen
 *   when zoomed in and would join every click on a satellite drawn over it. (Objects over a small disc that are still
 *   visible are the exempt ones: the selected, hovered and followed object and launch vehicles in flight.)
 * - no object: the bodies, in hierarchy order. A single body is selected directly, several (an Earth disc with a Moon dot
 *   in front of it) open the choice popup.
 *
 * Pass `bodies` as null when the objects alone decide (an object was found, so nothing is looked up).
 */
export function resolvePick(
  objects: { items: PickHit[]; total: number },
  bodies: { items: PickHit[]; total: number } | null,
): PickResolution {
  if (objects.items.length > 0 || !bodies) return { items: objects.items, total: objects.total };
  return { items: bodies.items, total: bodies.total };
}

/** Wheel pixels that make one step of the popup highlight (a mouse notch is 100, so one notch = one row). */
const WHEEL_STEP_PX = 100;

/**
 * Turns wheel events into whole row steps. Trackpads send many small deltas, so they accumulate; a direction change
 * drops what was accumulated the other way. Returns the new accumulator and the steps to move (+ down, - up).
 */
export function wheelSteps(acc: number, deltaY: number, deltaMode = 0): { acc: number; steps: number } {
  const px = deltaMode === 1 ? deltaY * 34 : deltaMode === 2 ? deltaY * 400 : deltaY;
  let a = (acc !== 0 && Math.sign(acc) !== Math.sign(px) ? 0 : acc) + px;
  const steps = Math.trunc(a / WHEEL_STEP_PX) + 0; // + 0: no -0
  a -= steps * WHEEL_STEP_PX;
  return { acc: a, steps };
}

/** Moves a highlight index by `steps`, stopping at both ends. */
export function moveIndex(i: number, steps: number, n: number): number {
  return n <= 0 ? 0 : Math.min(n - 1, Math.max(0, i + steps));
}

/** Top-left of a popup of `pw` x `ph` opened at the cursor: right and below it, flipped to the other side near an edge. */
export function popupPlacement(x: number, y: number, pw: number, ph: number, cw: number, ch: number, gap = 12): { left: number; top: number } {
  let left = x + gap, top = y + gap;
  if (left + pw > cw - 4) left = x - gap - pw;
  if (top + ph > ch - 4) top = y - gap - ph;
  return { left: Math.max(4, Math.min(left, cw - pw - 4)), top: Math.max(4, Math.min(top, ch - ph - 4)) };
}
