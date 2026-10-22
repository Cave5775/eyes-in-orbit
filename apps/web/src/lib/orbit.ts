import { EARTH, Sgp4Provider, cross, norm, type EntityGraph, type EntityRecord, type StateVector, type Vec3 } from '@eio/core';

/** Orbital period (s) if the entity is on a closed orbit clear of the atmosphere, else null. */
export function orbitPeriodSec(graph: EntityGraph, rec: EntityRecord, s: StateVector): number | null {
  const p = graph.provider(rec.id);
  if (p instanceof Sgp4Provider) return p.periodMin * 60;
  if (!s.v) return null;
  const r = norm(s.r), v = norm(s.v);
  const a = 1 / (2 / r - (v * v) / EARTH.gm);
  if (!(a > 0) || a > 5e5) return null;
  // eccentricity vector = (v x h)/mu - r/|r|, with h = r x v
  const vh = cross(s.v, cross(s.r, s.v));
  const e = norm(vh.map((x, i) => x / EARTH.gm - s.r[i] / r) as Vec3);
  if (e >= 1 || a * (1 - e) < EARTH.radiusKm + 100) return null;
  return 2 * Math.PI * Math.sqrt((a * a * a) / EARTH.gm);
}
