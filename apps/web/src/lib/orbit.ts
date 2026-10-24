import {
  Sgp4Provider, convert, cross, defaultBodies, norm, type EntityGraph, type EntityRecord, type FrameId, type StateVector, type Vec3,
} from '@eio/core';

/** Largest semi-major axis still treated as a closed orbit around the primary body (km). */
const MAX_SEMI_MAJOR_KM: Record<string, number> = { EARTH: 5e5 };
const MAX_SEMI_MAJOR_OTHER_KM = 1e5;
/** Closest periapsis above the primary's surface still treated as clear of its atmosphere (Earth only; the Moon has none). */
const ATMOSPHERE_KM: Record<string, number> = { EARTH: 100 };

/**
 * Orbital period (s) of the entity around its primary body (`rec.bodyId`: gm and radius of that body, not the Earth's), or
 * null when it is not on a closed orbit clear of the surface. `s` is the entity's state; when `tMs` is given it is
 * converted into the primary body's inertial frame first, otherwise it must already be in that frame.
 */
export function orbitPeriodSec(graph: EntityGraph, rec: EntityRecord, s: StateVector, tMs?: number): number | null {
  const p = graph.provider(rec.id);
  if (p instanceof Sgp4Provider) return p.periodMin * 60;
  if (!s.v) return null;
  let body;
  try {
    body = defaultBodies.get(rec.bodyId);
  } catch {
    return null; // unknown primary body
  }
  const target = `${body.id}:inertial` as FrameId;
  if (s.frame !== target) {
    if (tMs === undefined) return null;
    try {
      s = convert(s, target, tMs);
    } catch {
      return null;
    }
    if (!s.v) return null;
  }
  const gm = body.gm;
  const r = norm(s.r), v = norm(s.v);
  const a = 1 / (2 / r - (v * v) / gm);
  if (!(a > 0) || a > (MAX_SEMI_MAJOR_KM[body.id] ?? MAX_SEMI_MAJOR_OTHER_KM)) return null;
  // eccentricity vector = (v x h)/mu - r/|r|, with h = r x v
  const vh = cross(s.v, cross(s.r, s.v));
  const e = norm(vh.map((x, i) => x / gm - s.r[i] / r) as Vec3);
  if (e >= 1 || a * (1 - e) < body.radiusKm + (ATMOSPHERE_KM[body.id] ?? 0)) return null;
  return 2 * Math.PI * Math.sqrt((a * a * a) / gm);
}
