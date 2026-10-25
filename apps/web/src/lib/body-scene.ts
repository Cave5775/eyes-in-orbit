/**
 * Pure parts of the scene's handling of body entities (docs/frames.md, "Scene"): which body orbit lines to draw, the pick
 * extras of the drawn bodies and the rule that decides when a body is listed with the objects under the cursor
 * (`resolvePick`: only where no object is; objects over a small far body are hidden, lib/disc-hide.ts). No three.js.
 */
import type { EntityRecord } from '@eio/core';
import type { V3 } from './camera';
import type { DistanceScale } from './deepspace';
import { isEarthCentre, type Centre } from './frame';
import { earthOccludes, sphereOccludes, sphereView } from './occlusion';
import { gatherCandidates, bodyPickExtra, resolvePick, type PickExtra, type PickOptions, type PickResolution, type PickSource } from './pick';

/** A body as the scene draws it this frame (display space: shell-compressed in the compressed distance scale). */
export interface DrawnBody {
  /** entity id (`body-moon`) */
  entityId: string;
  /** centre in display space, km */
  c: V3;
  /** true radius, km, and the display shrink factor (1 in the true scale and for anything inside the shell) */
  radiusKm: number;
  k: number;
}

type LineRec = Pick<EntityRecord, 'id' | 'bodyId' | 'provider' | 'render' | 'attrs' | 'parentId'>;

/**
 * Can the orbit line of this body entity be drawn in this distance scale? It needs `render.orbitLine` (not the Sun). The
 * Moon's line is the same in both scales (it is inside the shell threshold). A body on the Sun's orbit (Earth, Mars) in the
 * true scale as it is. In the compressed scale the shell flattens everything beyond 2e6 km onto a thin shell, so a
 * heliocentric line is only drawn where it can be made consistent with the displayed Sun: the Earth's, by scaling the sampled
 * circle about the Earth with the Sun's display factor `k` (`refDisplay('SUN').k`, see `EntityOverlay.buildOrbit`), which
 * centres it on the displayed Sun and sends it through the displayed Earth. Mars is not on that circle (its displayed
 * position is the shell projection of its own, different, distance from the Earth, not a scaled copy of the orbit about
 * the Earth), so it stays true-scale only.
 */
export function bodyLineAllowed(rec: Pick<EntityRecord, 'bodyId' | 'provider' | 'render'>, scale: DistanceScale): boolean {
  if (rec.provider?.type !== 'body' || !rec.render?.orbitLine) return false;
  const heliocentric = rec.bodyId === 'SUN' && rec.provider.bodyId !== 'SUN';
  return scale === 'true' || !heliocentric || rec.provider.bodyId === 'EARTH';
}

export interface BodyLineInput {
  /** the selected entity, if any */
  selectedId: string | null;
  /** the frame of reference (an entity id) */
  frame: Centre;
  scale: DistanceScale;
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
    if (wanted && bodyLineAllowed(rec, input.scale)) out.push(rec.id);
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
 * 3 px). No ranks. A body behind the Earth or another body is dropped here, with its own sphere left out of its own test
 * (the centre of a body is inside it, which `sphereOccludes` takes for hidden) and the Earth never tested against itself.
 */
export function bodyPickExtras(bodies: readonly DrawnBody[], ctx: BodyPickContext): PickExtra[] {
  const out: PickExtra[] = [];
  for (const b of bodies) {
    const rel: V3 = [b.c[0] - ctx.origin[0], b.c[1] - ctx.origin[1], b.c[2] - ctx.origin[2]];
    const extra = bodyPickExtra({ id: b.entityId, rel, radiusKm: b.radiusKm, k: b.k, fovDeg: ctx.fovDeg, m: ctx.m, w: ctx.w, h: ctx.h, px: ctx.px, py: ctx.py });
    if (!extra) continue;
    if (!isEarthCentre(b.entityId) && earthOccludes(ctx.origin, rel)) continue;
    let hidden = false;
    for (const o of bodies) {
      if (o === b || isEarthCentre(o.entityId)) continue;
      if (sphereOccludes(sphereView(ctx.origin, { c: o.c, r: o.radiusKm * o.k }), rel[0], rel[1], rel[2])) {
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
