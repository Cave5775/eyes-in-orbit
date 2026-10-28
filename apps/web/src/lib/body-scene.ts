/**
 * Pure parts of the scene's handling of body entities (docs/frames.md, "Scene"): which body orbit lines to draw, the pick
 * extras of the drawn bodies and the rule that decides when a body is listed with the objects under the cursor
 * (`resolvePick`: only where no object is; objects over a small far body are hidden, lib/disc-hide.ts). No three.js.
 */
import type { EntityRecord } from '@eio/core';
import type { V3 } from './camera';
import type { Centre } from './frame';
import { newSphereView, setSphereView, sphereOccludes } from './occlusion';
import { gatherCandidates, bodyPickExtra, resolvePick, type PickExtra, type PickOptions, type PickResolution, type PickSource } from './pick';

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

type LineRec = Pick<EntityRecord, 'id' | 'bodyId' | 'provider' | 'render' | 'attrs' | 'parentId'>;

/**
 * Can the orbit line of this body entity be drawn? It needs `render.orbitLine` (not the Sun). Every line is the true orbit
 * about what the body orbits (the Moon about the Earth, the Earth and Mars about the Sun), drawn to scale like the bodies.
 */
export function bodyLineAllowed(rec: Pick<EntityRecord, 'provider' | 'render'>): boolean {
  return rec.provider?.type === 'body' && !!rec.render?.orbitLine;
}

export interface BodyLineInput {
  /** the selected entity, if any */
  selectedId: string | null;
  /** the frame of reference (an entity id) */
  frame: Centre;
}

/**
 * Body entities whose orbit line is drawn. The subjects are the selected entity and the frame centre; the camera subject is
 * always one of them (selecting flies to the selection, which also becomes the frame unless the frame is locked). Each
 * subject that is a body draws its own line (relative to what it orbits, whatever the frame or the lock is) and the lines of
 * its direct children (`parentId`: the Earth gives the Moon, the Sun the Earth and Mars; no grandchildren), each only where
 * `bodyLineAllowed`. So selecting a body from the tree, a breadcrumb, the scene or the popup shows the same lines. The default
 * frame (the Earth) is a subject too: the Earth's line and the Moon's. Bodies that are none of these stay unlined.
 */
export function bodyLineIds(recs: Iterable<LineRec>, input: BodyLineInput): string[] {
  const subjects = new Set<string>([input.frame]);
  if (input.selectedId !== null) subjects.add(input.selectedId);
  const out: string[] = [];
  for (const rec of recs) {
    if (rec.provider?.type !== 'body') continue;
    const wanted = subjects.has(rec.id) || (rec.parentId !== undefined && subjects.has(rec.parentId));
    if (wanted && bodyLineAllowed(rec)) out.push(rec.id);
  }
  return out;
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
 * One pick extra per drawn body under the cursor (`bodyPickExtra`: hit radius at least 14 px, the disc's angular radius plus
 * 3 px). No ranks. A body behind another body (the Earth included, one test for all: `sphereOccludes`) is dropped here, with
 * its own sphere left out of its own test (the centre of a body is inside it, which `sphereOccludes` takes for hidden).
 */
export function bodyPickExtras(bodies: readonly DrawnBody[], ctx: BodyPickContext): PickExtra[] {
  const out: PickExtra[] = [];
  const view = newSphereView();
  for (const b of bodies) {
    const rel: V3 = [b.c[0] - ctx.origin[0], b.c[1] - ctx.origin[1], b.c[2] - ctx.origin[2]];
    const extra = bodyPickExtra({ id: b.entityId, rel, radiusKm: b.radiusKm, k: b.k, fovDeg: ctx.fovDeg, m: ctx.m, w: ctx.w, h: ctx.h, px: ctx.px, py: ctx.py });
    if (!extra) continue;
    let hidden = false;
    for (const o of bodies) {
      if (o === b) continue;
      setSphereView(view, o.c[0] - ctx.origin[0], o.c[1] - ctx.origin[1], o.c[2] - ctx.origin[2], o.radiusKm * o.k, o.flattening);
      if (sphereOccludes(view, rel[0], rel[1], rel[2])) {
        hidden = true;
        break;
      }
    }
    if (!hidden) out.push(extra);
  }
  return out;
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
  return resolvePick(objects, list.length ? gatherCandidates([], list, m, w, h, px, py, opts) : { items: [], total: 0 });
}
