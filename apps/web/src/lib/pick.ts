/**
 * Screen-space picking, split from three.js so it can be tested: given the point sets (camera-relative positions, sizes,
 * show flags) and a projection * view matrix, list every visible object near a screen point, nearest first.
 *
 * One scan serves three callers so they cannot disagree: hover and a plain click take the first entry, and a click with
 * more than one entry opens the choice popup (ui/PickPopup.tsx) with the whole list.
 */

/** Everything whose centre is within this many CSS px of the cursor is a candidate (a point's own hit radius may be larger). */
export const CLUSTER_PX = 10;
/** Floor of a point's own hit radius, px (the radius is `max(MIN_HIT_PX, size / 2 + 4)`). */
export const MIN_HIT_PX = 6.05;
/** Rows the choice popup lists. */
export const POPUP_MAX = 12;

export interface PickSource {
  ids: readonly string[];
  /** camera-relative xyz, 3 per point (what the GPU gets) */
  rel: ArrayLike<number>;
  /** world xyz, 3 per point; an all-zero triple means "no position" */
  world: ArrayLike<number>;
  /** point size in px; 0 = not drawn */
  size: ArrayLike<number>;
  /** 0 = scoped out */
  show: ArrayLike<number>;
  /** squared px subtracted from the distance when ranking, so a propagated object beats a cloud point on a near tie */
  bias: number;
}

/** A candidate that is not in a point set (a drawn 3D model, the selected object's highlight). */
export interface PickExtra {
  id: string;
  /** squared px from the cursor, used for ranking */
  d2: number;
  /** camera-relative position; when given, an object behind the Earth (or the Moon, the Sun) is dropped */
  rel?: readonly [number, number, number];
}

export interface PickHit {
  id: string;
  /** px from the cursor */
  dist: number;
}

export interface PickOptions {
  /** most entries to return */
  max: number;
  /** keep counting past `max` so `total` is exact (the popup's "+ n more"); without it the scan stops at `max` */
  wantTotal?: boolean;
  clusterPx?: number;
  /** is the camera-relative point hidden behind a body? */
  occluded: (x: number, y: number, z: number) => boolean;
}

interface Raw {
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
      if (d2 <= r * r) raws.push({ rank: d2 - src.bias, d2, id: ids[i], x, y, z, checkOcc: true });
    }
  }
  for (const e of extras) {
    raws.push({ rank: e.d2, d2: e.d2, id: e.id, x: e.rel?.[0] ?? 0, y: e.rel?.[1] ?? 0, z: e.rel?.[2] ?? 0, checkOcc: !!e.rel });
  }
  raws.sort((a, b) => a.rank - b.rank);

  const items: PickHit[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const r of raws) {
    if (seen.has(r.id)) continue;
    if (r.checkOcc && opts.occluded(r.x, r.y, r.z)) continue;
    seen.add(r.id);
    total++;
    if (items.length < opts.max) items.push({ id: r.id, dist: Math.sqrt(r.d2) });
    else if (!opts.wantTotal) break;
  }
  return { items, total };
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
