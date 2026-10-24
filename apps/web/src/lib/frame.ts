import { convert, defaultBodies, type EntityGraph, type StateVector, type Vec3 } from '@eio/core';
import { isRefBody, refPositionEci } from './ref-body';

/**
 * Frame of reference (see docs/frames.md). The frame is a centre, a body or an entity. Frames are translations only
 * (no rotation): the centre is a point `c(t)` in Earth-inertial coordinates. Entities stay stored and drawn in
 * Earth-inertial space; the frame changes what depends on time: paths, trails and orbit lines are sampled relative to
 * the centre at each sample time and drawn around the centre's current position, and readouts are relative to it.
 */
export type Centre = { kind: 'body'; id: string } | { kind: 'entity'; id: string };

/** The default frame: the Earth. With it every output equals the pre-frame behaviour (c(t) = 0). */
export const EARTH_CENTRE: Centre = { kind: 'body', id: 'EARTH' };

export const bodyCentre = (id: string): Centre => ({ kind: 'body', id });
export const entityCentre = (id: string): Centre => ({ kind: 'entity', id });

export const isEarthCentre = (c: Centre): boolean => c.kind === 'body' && c.id === 'EARTH';

export const sameCentre = (a: Centre, b: Centre): boolean => a.kind === b.kind && a.id === b.id;

/**
 * The frame an entity's own paths and orbit line are drawn in: the active centre, except that nothing can be drawn
 * relative to itself (a single point), so the entity that is the centre is drawn relative to its primary body.
 */
export const frameFor = (centre: Centre, entityId: string, primaryBodyId: string): Centre =>
  centre.kind === 'entity' && centre.id === entityId ? bodyCentre(primaryBodyId) : centre;

/** Stable string for a centre (cache keys). */
export const centreKey = (c: Centre): string => `${c.kind}:${c.id}`;

/**
 * Bodies the scene can centre on: the ones it draws and has a display for (Earth, Moon, Sun; Mars has no map or
 * ephemeris display yet). Used by `select` to decide whether selecting something re-centres the frame.
 */
export const isOrbitableBody = (id: string): boolean => isRefBody(id);

/** The Earth-inertial state of an entity at `tMs` (null: no state at that time or unknown entity). */
export type EntityLookup = (id: string, tMs: number) => StateVector | null;

/** Lookup over an `EntityGraph` (the entity must have been upserted into it). */
export const graphLookup = (graph: EntityGraph): EntityLookup => (id, t) => graph.stateIn(id, t, 'EARTH:inertial');

const ZERO: Vec3 = [0, 0, 0];

/** Position and velocity of a body's centre in Earth-inertial coordinates, or null for an unknown body. */
function bodyStateEci(id: string, t: number): { r: Vec3; v?: Vec3 } | null {
  if (id === 'EARTH') return { r: ZERO, v: ZERO };
  try {
    const hop = convert({ frame: `${id}:inertial`, r: ZERO, v: ZERO }, 'EARTH:inertial', t);
    // the displayed positions of the Moon and the Sun come from the almanac series, the same one the scene draws
    return { r: isRefBody(id) ? refPositionEci(id, t) : hop.r, v: hop.v };
  } catch {
    return null;
  }
}

/** Position of the centre at `tMs` in Earth-inertial coordinates, km, or null when it has no state then. */
export function centrePositionEci(centre: Centre, tMs: number, lookup: EntityLookup): Vec3 | null {
  if (centre.kind === 'body') return bodyStateEci(centre.id, tMs)?.r ?? null;
  return lookup(centre.id, tMs)?.r ?? null;
}

/** Position and (when known) velocity of the centre in Earth-inertial coordinates. */
export function centreStateEci(centre: Centre, tMs: number, lookup: EntityLookup): { r: Vec3; v?: Vec3 } | null {
  if (centre.kind === 'body') return bodyStateEci(centre.id, tMs);
  const s = lookup(centre.id, tMs);
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
}
export type RecLookup = (id: string) => RecLabel | undefined;

function bodyName(id: string): string {
  try {
    return defaultBodies.get(id).name;
  } catch {
    return id;
  }
}

/** Short label of a centre: `Moon` for a body, the entity's name for an entity (its id when unknown). */
export function centreLabel(centre: Centre, rec: RecLookup): string {
  return centre.kind === 'body' ? bodyName(centre.id) : rec(centre.id)?.name ?? centre.id;
}

export interface Crumb {
  label: string;
  /** the centre a click on this crumb would set */
  centre: Centre;
}

/** Body ids from the root down to `id` (`SUN, EARTH, MOON`); just `[id]` for an unknown body. */
function bodyChain(id: string): string[] {
  try {
    return defaultBodies.lineage(id).map((b) => b.id).reverse();
  } catch {
    return [id];
  }
}

/**
 * The breadcrumb of a frame: for a body its lineage from the root (`SUN > EARTH > MOON`), for an entity its primary
 * body's lineage and then the entity itself (`SUN > EARTH > MOON > LRO`).
 */
export function frameCrumbs(centre: Centre, rec: RecLookup): Crumb[] {
  if (centre.kind === 'body') return bodyChain(centre.id).map((id) => ({ label: id, centre: bodyCentre(id) }));
  const r = rec(centre.id);
  const crumbs = r ? bodyChain(r.bodyId).map((id) => ({ label: id, centre: bodyCentre(id) })) : [];
  crumbs.push({ label: r?.name ?? centre.id, centre });
  return crumbs;
}

/** `SUN > EARTH > MOON` (see `frameCrumbs`). */
export const frameChainLabel = (centre: Centre, rec: RecLookup): string => frameCrumbs(centre, rec).map((c) => c.label).join(' > ');
