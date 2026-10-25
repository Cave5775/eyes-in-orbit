import { bodyEntityId, isBodyEntity, type EntityGraph, type EntityRecord, type StateVector, type Vec3 } from '@eio/core';

/**
 * Frame of reference (see docs/frames.md). The frame is a centre, and a centre is an ENTITY ID: a body entity (`body-moon`)
 * or any other entity (an orbitable asteroid, a satellite the user locked the frame to). There is no second, registry-id
 * representation of a body here. Frames are translations only (no rotation): the centre is a point `c(t)` in Earth-inertial
 * coordinates. Entities stay stored and drawn in Earth-inertial space; the frame changes what depends on time: paths,
 * trails and orbit lines are sampled relative to the centre at each sample time and drawn around the centre's current
 * position, and readouts are relative to it.
 */
export type Centre = string;

/** The default frame: the Earth. With it every output equals the pre-frame behaviour (c(t) = 0, the identity fast path). */
export const EARTH_CENTRE: Centre = bodyEntityId('EARTH');

export const isEarthCentre = (c: Centre): boolean => c === EARTH_CENTRE;

/**
 * The frame an entity's own paths and orbit line are drawn in: the active centre, except that
 * - nothing can be drawn relative to itself (a single point), so the entity that is the centre is drawn relative to its
 *   primary body, and
 * - a body ENTITY always draws its orbit in its parent body's frame whatever the active centre is: the Moon as an ellipse
 *   around the Earth, Earth and Mars around the Sun's current position. The Sun orbits nothing (its `bodyId` names itself)
 *   and keeps the active centre.
 */
export function frameForRec(centre: Centre, rec: Pick<EntityRecord, 'id' | 'bodyId' | 'provider'>): Centre {
  const primary = bodyEntityId(rec.bodyId);
  if (isBodyEntity(rec)) return primary === rec.id ? centre : primary;
  return centre === rec.id ? primary : centre;
}

/** The Earth-inertial state of an entity at `tMs` (null: no state at that time or unknown entity). */
export type EntityLookup = (id: string, tMs: number) => StateVector | null;

/** Lookup over an `EntityGraph` (the entity must have been upserted into it; body entities are, see SceneController). */
export const graphLookup = (graph: EntityGraph): EntityLookup => (id, t) => graph.stateIn(id, t, 'EARTH:inertial');

/** Position of the centre at `tMs` in Earth-inertial coordinates, km, or null when it has no state then. The Earth is the origin. */
export function centrePositionEci(centre: Centre, tMs: number, lookup: EntityLookup): Vec3 | null {
  if (isEarthCentre(centre)) return [0, 0, 0];
  return lookup(centre, tMs)?.r ?? null;
}

/** Position and (when known) velocity of the centre in Earth-inertial coordinates. */
export function centreStateEci(centre: Centre, tMs: number, lookup: EntityLookup): { r: Vec3; v?: Vec3 } | null {
  if (isEarthCentre(centre)) return { r: [0, 0, 0], v: [0, 0, 0] };
  const s = lookup(centre, tMs);
  return s ? { r: s.r, v: s.v } : null;
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/**
 * An Earth-inertial state relative to the centre's state at the same time. A translation, so velocities subtract too
 * (no rotation term: the frame does not spin). Velocity is present only when both have one.
 */
export function relativeState(s: { r: Vec3; v?: Vec3 }, c: { r: Vec3; v?: Vec3 }): { r: Vec3; v?: Vec3 } {
  return { r: sub3(s.r, c.r), v: s.v && c.v ? sub3(s.v, c.v) : undefined };
}

/** Relative position and velocity of an entity (looked up by id) to a centre at `tMs`, null when either has no state. */
export function entityRelativeToCentre(id: string, centre: Centre, tMs: number, lookup: EntityLookup): { r: Vec3; v?: Vec3 } | null {
  const s = lookup(id, tMs);
  const c = centreStateEci(centre, tMs, lookup);
  return s && c ? relativeState(s, c) : null;
}

/**
 * Where the sample of a path taken at `t_i` is drawn: its position relative to the centre at that time, around the
 * centre's position at the reference time: r(t_i) - c(t_i) + c(ref). With c = 0 this is r(t_i).
 */
export function framePathPoint(r: Vec3, cAtSample: Vec3, cAtRef: Vec3): Vec3 {
  return [r[0] - cAtSample[0] + cAtRef[0], r[1] - cAtSample[1] + cAtRef[1], r[2] - cAtSample[2] + cAtRef[2]];
}

/**
 * Samples a path in a frame: `centreAt(t)` is the centre's Earth-inertial position (null: no state), `ref` its position at
 * the time the path is built for (`refMs`; null: the centre has no state then and nothing can be drawn). The drawn path
 * is later shifted by c(now) - ref as the centre moves, so it follows the centre without being rebuilt.
 */
export interface FrameSampler {
  centreAt(tMs: number): Vec3 | null;
  ref: Vec3 | null;
  refMs: number;
}

/** A sampler for `centre` built around `refMs`, or undefined for the Earth (identity: nothing to do). */
export function frameSampler(centre: Centre, refMs: number, lookup: EntityLookup): FrameSampler | undefined {
  if (isEarthCentre(centre)) return undefined;
  return {
    centreAt: (t) => centrePositionEci(centre, t, lookup),
    ref: centrePositionEci(centre, refMs, lookup),
    refMs,
  };
}

// ------------------------------------------------------------------ labels

/** What is needed of an entity record to label a frame. */
export interface RecLabel {
  name: string;
  bodyId: string;
  /** entity id of the parent body (set on body entities) */
  parentId?: string;
  provider?: { type: string };
}
export type RecLookup = (id: string) => RecLabel | undefined;

/** Short label of a centre: the entity's name (its id when unknown). */
export const centreLabel = (centre: Centre, rec: RecLookup): string => rec(centre)?.name ?? centre;

export interface Crumb {
  label: string;
  /** the entity a click on this crumb would select (and, when orbitable, make the frame) */
  id: Centre;
}

/**
 * The breadcrumb of a frame, root first, one crumb per entity: for a body entity its ancestors (`Sun > Earth > Moon`), for any
 * other entity its primary body's ancestors and then the entity itself (`Sun > Earth > Moon > LRO`). The chain follows the
 * body entities' `parentId`; it stops at an ancestor that is not in the lookup.
 */
export function frameCrumbs(centre: Centre, rec: RecLookup): Crumb[] {
  const ids: string[] = [centre];
  const r = rec(centre);
  let up: string | undefined = r ? (r.provider?.type === 'body' ? r.parentId : bodyEntityId(r.bodyId)) : undefined;
  while (up && !ids.includes(up) && rec(up)) {
    ids.unshift(up);
    up = rec(up)?.parentId;
  }
  return ids.map((id) => ({ label: rec(id)?.name ?? id, id }));
}

/** `Sun > Earth > Moon` (see `frameCrumbs`). */
export const frameChainLabel = (centre: Centre, rec: RecLookup): string => frameCrumbs(centre, rec).map((c) => c.label).join(' > ');
