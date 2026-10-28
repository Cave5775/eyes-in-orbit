/**
 * Which orbit lines the scene draws: ONE rule, and nothing else decides it (docs/frames.md, "Orbit-line rule").
 *
 * - The SELECTED entity's trajectory is always drawn, at full strength: its orbit line round its primary body.
 * - The orbits of its CHILDREN (the entities that orbit it: a planet's moons and orbiters, the Earth's satellites, a moon's
 *   probes) are drawn DIMMED (the same look as HIGHLIGHT, `lib/dim.ts`), without trail, footprint or ground track.
 * - Nothing is drawn without a selection, and nothing else is ever drawn: not the frame centre, not what is near the camera.
 *   The frame (locked or not) and the camera do not change which lines exist.
 *
 * Pure: no three.js, no frame, no camera, no clock.
 */
import { bodyOf, compareHierarchy, type EntityRecord } from '@eio/core';

/** At most this many child orbits are drawn (the Earth has thousands of satellites). */
export const CHILD_ORBIT_LIMIT = 12;

export type OrbitRole = 'selected' | 'child';

export interface OrbitLineSpec {
  id: string;
  role: OrbitRole;
}

export type OrbitRec = Pick<EntityRecord, 'id' | 'bodyId' | 'parentId' | 'provider' | 'render' | 'createdAt' | 'updatedAt'>;

const isBodyRec = (rec: OrbitRec): boolean => rec.provider?.type === 'body';

/**
 * Can an object that is not flagged `render.orbitLine` have a closed orbit round its primary? Probes and the like (sampled
 * ephemerides, Kepler elements) can. The mass catalog (SGP4), pads and stations on the ground (geodetic), launch vehicles
 * (composite, relative) get a child line only where the data flags it with `render.orbitLine`.
 */
const hasOrbitProvider = (rec: OrbitRec): boolean => rec.provider?.type === 'sampled' || rec.provider?.type === 'keplerian';

/**
 * The orbit lines to draw for a selection, the selected entity first, then up to `CHILD_ORBIT_LIMIT` children.
 *
 * - The selected entity: a body entity only where it has an orbit line (`render.orbitLine`: the Sun has none), any other
 *   entity always (its overlay draws what exists: the orbit, the footprint, the ground track, the trail).
 * - The children of a body: the body entities whose `parentId` is the body (the Earth gives the Moon, the Sun the planets)
 *   and the objects whose primary `bodyId` is the body (the Earth's satellites, the Moon's probes), only those the
 *   data flags with `render.orbitLine` or that `hasOrbitProvider`. An object has no children.
 * - `visible` says whether the query shows a child (a hidden group keeps no orbit line); the selected entity is kept.
 * - Order, when there are more than the limit: body entities first (`entityRank`: the planets before the moons), then the
 *   flagged objects, then the other objects; within each the usual hierarchy order (`compareHierarchy`: rank, newest first,
 *   id). The order does not depend on the camera or the clock, so the set does not change while the user moves.
 */
export function orbitLines<R extends OrbitRec>(recs: ReadonlyMap<string, R>, selectedId: string | null, visible: (rec: R) => boolean = () => true): OrbitLineSpec[] {
  const sel = selectedId === null ? undefined : recs.get(selectedId);
  if (!sel) return [];
  const out: OrbitLineSpec[] = [];
  if (!isBodyRec(sel) || sel.render?.orbitLine) out.push({ id: sel.id, role: 'selected' });
  const selBody = bodyOf(sel);
  if (selBody === undefined) return out;

  const group = (rec: R): number => (isBodyRec(rec) ? 0 : rec.render?.orbitLine ? 1 : 2);
  const children: R[] = [];
  for (const rec of recs.values()) {
    if (rec.id === sel.id) continue;
    if (isBodyRec(rec) ? rec.parentId !== sel.id || !rec.render?.orbitLine : rec.bodyId !== selBody || !(rec.render?.orbitLine || hasOrbitProvider(rec))) continue;
    if (visible(rec)) children.push(rec);
  }
  children.sort((a, b) => group(a) - group(b) || compareHierarchy(a, b));
  for (const rec of children.slice(0, CHILD_ORBIT_LIMIT)) out.push({ id: rec.id, role: 'child' });
  return out;
}
