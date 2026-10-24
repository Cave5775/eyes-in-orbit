/**
 * Pure parts of the scene's handling of body entities (docs/frames.md, "Scene"): which body orbit lines to draw, the pick
 * extras of the drawn bodies and the rule that a body is only picked where no other object is. No three.js.
 */
import { orbitableBodyId, type EntityRecord } from '@eio/core';
import type { V3 } from './camera';
import type { DistanceScale } from './deepspace';
import { isEarthCentre, type Centre } from './frame';
import { earthOccludes, sphereOccludes, sphereView } from './occlusion';
import { gatherCandidates, bodyPickExtra, type PickExtra, type PickHit, type PickOptions, type PickSource } from './pick';

/** A body as the scene draws it this frame (display space: shell-compressed in the compressed distance scale). */
export interface DrawnBody {
  /** entity id (`body-moon`) */
  entityId: string;
  /** registry id (`MOON`) */
  bodyId: string;
  /** centre in display space, km */
  c: V3;
  /** true radius, km, and the display shrink factor (1 in the true scale and for anything inside the shell) */
  radiusKm: number;
  k: number;
}

type LineRec = Pick<EntityRecord, 'id' | 'bodyId' | 'provider' | 'render' | 'attrs'>;

/**
 * Can the orbit line of this body entity be drawn in this distance scale? It needs `render.orbitLine` (not the Sun). A body
 * on the Sun's orbit (Earth, Mars) only in the true scale: the shell compression flattens heliocentric orbits (everything
 * beyond 2e6 km is pushed onto a thin shell), so the line would be a meaningless blob there. The Moon's line is the same in
 * both scales (it is inside the shell threshold).
 */
export function bodyLineAllowed(rec: Pick<EntityRecord, 'bodyId' | 'provider' | 'render'>, scale: DistanceScale): boolean {
  if (rec.provider?.type !== 'body' || !rec.render?.orbitLine) return false;
  const heliocentric = rec.bodyId === 'SUN' && rec.provider.bodyId !== 'SUN';
  return scale === 'true' || !heliocentric;
}

export interface BodyLineInput {
  /** the selected entity, if any */
  selectedId: string | null;
  /** registry id of the body the camera is centred on (`bodyTarget`), if any */
  focusBodyId: string | null;
  /** the frame of reference */
  frame: Centre;
  scale: DistanceScale;
}

/**
 * Body entities whose orbit line is drawn: the selected one, the one the camera is centred on and the one that is the frame
 * centre (a body's own orbit is drawn in its parent's frame whatever the frame is, so these are the lines the user is looking
 * at), each only where `bodyLineAllowed`. Other bodies stay unlined to keep the default view unchanged.
 */
export function bodyLineIds(recs: Iterable<LineRec>, input: BodyLineInput): string[] {
  const out: string[] = [];
  for (const rec of recs) {
    if (rec.provider?.type !== 'body') continue;
    const reg = orbitableBodyId(rec);
    const wanted =
      rec.id === input.selectedId ||
      (input.focusBodyId !== null && reg === input.focusBodyId) ||
      (input.frame.kind === 'body' && reg === input.frame.id && !isEarthCentre(input.frame)) || // the default frame draws nothing
      (input.frame.kind === 'entity' && rec.id === input.frame.id);
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
    if (b.bodyId !== 'EARTH' && earthOccludes(ctx.origin, rel)) continue;
    let hidden = false;
    for (const o of bodies) {
      if (o === b || o.bodyId === 'EARTH') continue;
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
 * Candidates near the cursor: the objects first (points, models, the selection, as `gatherCandidates`), and only when there
 * are none the drawn bodies. The Earth's disc covers most of the screen, so a body that joined the object candidates would
 * turn every click on a satellite drawn over the disc into a choice popup. (The hierarchy ordering and the zoomed-out
 * aggregation replace this rule later.)
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
): { items: PickHit[]; total: number } {
  const r = gatherCandidates(sources, extras, m, w, h, px, py, opts);
  if (r.items.length > 0) return r;
  const bodies = bodyExtras();
  return bodies.length ? gatherCandidates([], bodies, m, w, h, px, py, opts) : r;
}
