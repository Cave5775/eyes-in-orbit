/**
 * Pure parts of the scene's handling of body entities (docs/frames.md, "Scene"): the pick extras of the drawn bodies and the
 * rule that decides when a body is listed with the objects under the cursor (`resolvePick`: only where no object is; objects
 * over a small far body are hidden, lib/disc-hide.ts). No three.js. (Which orbit lines are drawn: lib/orbit-lines.ts.)
 */
import type { V3 } from './camera';
import { newSphereView, setSphereView, sphereOccludes } from './occlusion';
import { gatherCandidates, pickPrecedence, probeBody, probeExtra, resolvePick, type BodyProbe, type CoverDisc, type PickExtra, type PickOptions, type PickResolution, type PickSource } from './pick';

/** A body as the scene draws it this frame (true position and radius). */
export interface DrawnBody {
  /** entity id (`body-moon`) */
  entityId: string;
  /** centre, km */
  c: V3;
  /** true radius, km, and the factor it is drawn with (always 1: everything is drawn to scale) */
  radiusKm: number;
  k: number;
  /** flattening (0 or absent: a sphere; the Earth's: the ellipsoid), as lib/occlusion.ts `SceneBody` */
  flattening?: number;
}

export interface BodyPickContext {
  /** the camera in world space (the floating origin) */
  origin: V3;
  /** column-major projection * view matrix and viewport size in CSS px */
  m: ArrayLike<number>;
  w: number;
  h: number;
  /** the cursor in CSS px from the top-left of the viewport */
  px: number;
  py: number;
  fovDeg: number;
}

/**
 * The drawn bodies under the cursor, by the one precedence rule (`pickPrecedence`, lib/pick.ts): `extras` are the pick
 * extras (no ranks of their own; the hierarchy comes from `PickOptions.ranks`) and `covers` the discs holding the cursor,
 * for `PickOptions.covers`. A body behind another body (the Earth included, one test for all: `sphereOccludes`) is dropped
 * first, with its own sphere left out of its own test (the centre of a body is inside it, which `sphereOccludes` takes for
 * hidden).
 */
export function bodyPickScan(bodies: readonly DrawnBody[], ctx: BodyPickContext): { extras: PickExtra[]; covers: CoverDisc[] } {
  const probes: BodyProbe[] = [];
  const view = newSphereView();
  for (const b of bodies) {
    const rel: V3 = [b.c[0] - ctx.origin[0], b.c[1] - ctx.origin[1], b.c[2] - ctx.origin[2]];
    const p = probeBody({ id: b.entityId, rel, radiusKm: b.radiusKm, k: b.k, fovDeg: ctx.fovDeg, m: ctx.m, w: ctx.w, h: ctx.h, px: ctx.px, py: ctx.py });
    if (!p) continue;
    let hidden = false;
    for (const o of bodies) {
      if (o === b) continue;
      setSphereView(view, o.c[0] - ctx.origin[0], o.c[1] - ctx.origin[1], o.c[2] - ctx.origin[2], o.radiusKm * o.k, o.flattening);
      if (sphereOccludes(view, rel[0], rel[1], rel[2])) {
        hidden = true;
        break;
      }
    }
    if (!hidden) probes.push(p);
  }
  const { hits, covers } = pickPrecedence(probes);
  return { extras: hits.map(probeExtra), covers };
}

/** The pick extras of `bodyPickScan`. */
export function bodyPickExtras(bodies: readonly DrawnBody[], ctx: BodyPickContext): PickExtra[] {
  return bodyPickScan(bodies, ctx).extras;
}

/**
 * Candidates near the cursor, as `resolvePick` decides: the objects (points, models, the selection, as `gatherCandidates`,
 * highest in the hierarchy first, then newest), and the drawn bodies where there is no object. Objects over a small, far body
 * are not candidates (`PickOptions.discHidden`), so there the click finds the body. A body never joins the objects: the
 * Earth's disc covers most of the screen when zoomed in and would turn every click on a satellite drawn over it into a
 * choice popup.
 */
export function gatherWithBodies(
  sources: readonly PickSource[],
  extras: readonly PickExtra[],
  bodyExtras: () => readonly PickExtra[],
  m: ArrayLike<number>,
  w: number,
  h: number,
  px: number,
  py: number,
  opts: PickOptions,
): PickResolution {
  const objects = gatherCandidates(sources, extras, m, w, h, px, py, opts);
  // an object is aimed at, whatever is behind it: the body lookup is skipped
  if (objects.total > 0) return resolvePick(objects, null);
  const list = bodyExtras();
  return resolvePick(objects, list.length ? gatherCandidates([], list, m, w, h, px, py, { ...opts, covers: undefined }) : { items: [], total: 0 });
}
