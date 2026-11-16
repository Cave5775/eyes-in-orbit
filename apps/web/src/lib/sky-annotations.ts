import { DEG, EARTH, bodyEntityId, bodyOf, bodyStateEci, gmstRad, isBodyStreamed, type EntityRecord } from '@eio/core';
import type { V3 } from './camera';
import { LABEL_H } from './labels';
import { dirToRaDec, precessDir, raDecToDir, type RaDec } from './sky-frame';

/**
 * Sky annotations (pure): where the tracked solar-system bodies are on the sky of an observatory, which of them to mark, and
 * how to keep the markers readable. The Sky view (Aladin Lite) draws what this returns; nothing here knows Aladin or the DOM.
 *
 * Which bodies: the Sun, the Moon, the planets, the dwarf planets, and the moons that have a streamed position (see
 * `selectBodies`). The observer's own body (the Earth) and every non-body entity (satellites, probes) are not annotated.
 *
 * Positions are TOPOCENTRIC: the direction from the observer's position to the body, in J2000 RA/Dec (what Aladin and the HiPS
 * surveys use). The parallax matters for the Moon (up to 1.03 deg at perigee, `topocentricRaDec`) and is under 0.1 deg for
 * anything but the Moon and the Sun (the Sun's is 8.8 arcsec).
 *
 * Ignored on purpose, with their sizes: light time (the body is shown where it is, not where it was when the light left it:
 * the Moon moves 0.5 arcsec in its 1.3 s, a planet up to ~0.01 deg in minutes, the Sun 0.0056 deg in 8.3 min); stellar and
 * diurnal aberration (up to 20.5 arcsec and 0.32 arcsec); refraction (about 0.57 deg at the horizon: the markers are the
 * geometric directions, like the horizon test); nutation (up to 17 arcsec in longitude); the Earth's flattening in the
 * occultation test (21 km of 6378 km). All are under the accuracy of the sources themselves (the Moon series is 0.3 deg).
 */

/** The axes a body's scene position is expressed in. */
export type Epoch = 'date' | 'j2000';

/**
 * The ONE place that decides the axes of a body's position in the scene's Earth-inertial frame (docs/frames.md, "Sky
 * pointing"). Since the heliocentric hop was put in the axes of date (core `frameEpoch`, `hopInertial`), EVERY body is of date:
 * the Sun and the Moon come from series of the date, a planet, dwarf planet or moon is its J2000 (ICRF) orbit, fallback Kepler
 * or Horizons stream alike, precessed to the date in the hop. `bodyId` is a registry id (`MOON`, not `body-moon`). Kept as a
 * function so a future body with J2000 axes has one place to say so.
 */
// It relies on core (`frameEpoch`, `hopInertial`) putting EVERY body in the scene's of-date axes; if a body ever enters the scene
// in J2000 axes again, this is the one place to say so (and the observer must then be precessed with it).
export function epochOf(_bodyId: string): Epoch {
  return 'date';
}

const D: V3 = [0, 0, 0];

/**
 * J2000 RA/Dec (degrees, RA in [0, 360)) of the direction from an observer at `rObs` to a target at `rTarget`, both km in the
 * same frame, `d = rTarget - rObs` in float64. `epoch` is the axes of that frame (`epochOf`): a frame of date is precessed to
 * J2000 (IAU 1976, `precessDir`), a J2000 frame is used as it is. Geometric: no light time, aberration or refraction. Fills
 * `out` when given (no allocation but the dirToRaDec result). The zero vector gives RA 0, Dec 0.
 */
export function topocentricRaDec(rTarget: V3, rObs: V3, tMs: number, epoch: Epoch, out: RaDec = { raDeg: 0, decDeg: 0 }): RaDec {
  D[0] = rTarget[0] - rObs[0];
  D[1] = rTarget[1] - rObs[1];
  D[2] = rTarget[2] - rObs[2];
  if (epoch === 'date') precessDir(D, tMs, true, D);
  const r = dirToRaDec(D);
  out.raDeg = r.raDeg;
  out.decDeg = r.decDeg;
  return out;
}

/**
 * Is the target below the geometric horizon of a ground observer (elevation < 0): the line of sight points away from the
 * local vertical. `up` is the unit vertical in the same frame (`groundObserver`); without it the geocentric vertical `rObs`
 * is used (it differs from the geodetic one by up to 0.19 deg of latitude). No refraction and no dip: the horizon is the
 * horizontal plane through the observer. A target exactly on the horizon is not below.
 */
export function belowHorizon(rTarget: V3, rObs: V3, up?: V3): boolean {
  const dx = rTarget[0] - rObs[0], dy = rTarget[1] - rObs[1], dz = rTarget[2] - rObs[2];
  const u = up ?? rObs;
  return dx * u[0] + dy * u[1] + dz * u[2] < 0; // the length of `u` does not change the sign
}

/**
 * Does the Earth (a sphere of the equatorial radius, 6378.137 km) lie between a space observer and the target: the segment from
 * `rObs` to `rTarget` crosses the sphere. An observer on or inside the sphere (a ground site) is never "behind": use
 * `belowHorizon` for those. The flattening (21 km at the poles) is ignored.
 */
export function behindEarth(rTarget: V3, rObs: V3): boolean {
  const R = EARTH.radiusKm;
  const dx = rTarget[0] - rObs[0], dy = rTarget[1] - rObs[1], dz = rTarget[2] - rObs[2];
  const len = Math.hypot(dx, dy, dz);
  if (len === 0) return false;
  const c = rObs[0] * rObs[0] + rObs[1] * rObs[1] + rObs[2] * rObs[2] - R * R;
  if (c <= 0) return false;
  const b = (rObs[0] * dx + rObs[1] * dy + rObs[2] * dz) / len; // observer position along the unit line of sight
  const disc = b * b - c;
  if (disc <= 0) return false; // the line misses (or only grazes) the sphere
  const s = -b - Math.sqrt(disc); // distance to the near intersection
  return s > 0 && s < len;
}

// ---------------------------------------------------------------------------------------------------------------------
// The observer
// ---------------------------------------------------------------------------------------------------------------------

/** Where the observer is (Earth-inertial axes of date, km), and for a ground site the unit local vertical. */
export interface SkyObserver {
  r: V3;
  /** unit geodetic vertical (same axes); set for a ground observer, which uses the horizon test; unset: a space observer */
  up?: V3;
  /** registry id of the body the observer stands on or orbits, never annotated; default `EARTH` */
  bodyId?: string;
}

/**
 * A ground site as an observer: the geodetic position (WGS-84 ellipsoid of core `EARTH`) rotated into the inertial axes by the
 * mean sidereal angle (the same GMST as `lstRad`, so the vertical's RA is the local sidereal time and its Dec the geodetic
 * latitude, as `zenithRaDec`), and the unit geodetic vertical. Longitude east positive, `altKm` above the ellipsoid.
 */
export function groundObserver(latDeg: number, lonDeg: number, altKm: number, tMs: number): SkyObserver {
  const lat = latDeg * DEG, lon = lonDeg * DEG + gmstRad(tMs);
  const sl = Math.sin(lat), cl = Math.cos(lat);
  const e2 = EARTH.flattening * (2 - EARTH.flattening);
  const N = EARTH.radiusKm / Math.sqrt(1 - e2 * sl * sl);
  const rho = (N + altKm) * cl, z = (N * (1 - e2) + altKm) * sl;
  const co = Math.cos(lon), so = Math.sin(lon);
  return { r: [rho * co, rho * so, z], up: [cl * co, cl * so, sl], bodyId: 'EARTH' };
}

// ---------------------------------------------------------------------------------------------------------------------
// Which bodies, and where
// ---------------------------------------------------------------------------------------------------------------------

/** One annotation. `hidden` means "not visible from the observer" (below the horizon or behind the Earth), NOT hidden by a query: those are dropped. The UI dims it. */
export interface SkyMarker {
  /** entity id (`body-mars`) */
  id: string;
  name: string;
  /** entity kind: `star`, `planet`, `dwarf_planet` or `moon` */
  kind: string;
  /** J2000, topocentric */
  raDeg: number;
  decDeg: number;
  /** distance from the observer, km */
  distKm: number;
  hidden: boolean;
  /** the position is a rough one: an offline fallback (not streamed) of a body flagged `approx`. The Sun and the Moon are series of about 0.01 and 0.3 deg and say so. */
  approx: boolean;
}

export interface SelectOptions {
  tMs: number;
  observer: SkyObserver;
  /** True when the query hides the record: `(rec) => !isDrawn(classify(rec, query, ctx))`. Hidden and filtered-out records are dropped. */
  isHidden: (rec: EntityRecord) => boolean;
  /** Earth-inertial position of a registry body, km, or null when it has none; default core `bodyStateEci` (the scene's positions) */
  positionOf?: (bodyId: string, tMs: number) => V3 | null;
  /** Is the position a streamed one at `tMs`; default core `isBodyStreamed` */
  isStreamed?: (bodyId: string, tMs: number) => boolean;
}

const KINDS: ReadonlySet<string> = new Set(['star', 'planet', 'dwarf_planet', 'moon']);

const rel: V3 = [0, 0, 0];
const tmpRd: RaDec = { raDeg: 0, decDeg: 0 };

/**
 * The markers for the body entities in `records`, one per body, in record order.
 *
 * - Dropped: records that are not bodies, other kinds, the observer's own body, bodies the query hides (`isHidden`), bodies
 *   with no finite position.
 * - Moons: only the observer's own moon (the Moon: it has its own ephemeris series) and the moons whose position is streamed at
 *   `tMs`. The offline fallback of every other moon has an ARBITRARY phase (bodies.ts: mean anomaly, node and periapsis are
 *   zero at J2000), and a marker for it would be a made-up position. The entity's `approx` attribute is static (always true
 *   for a moon) and cannot tell; `isBodyStreamed` can. A moon of an unstreamed planet is as good as the planet (arcmin).
 * - Kept and flagged: `hidden` for a body below the ground observer's horizon or behind the Earth for a space observer.
 * - `approx` is the entity's flag without a stream: a streamed body (JPL Horizons) is not approximate.
 *
 * Every body is of date in the scene (planets and moons included, see `epochOf`), so the observer and the bodies share one
 * geometry and only the final direction is precessed to J2000 (`topocentricRaDec`).
 */
export function selectBodies(records: Iterable<EntityRecord>, opts: SelectOptions): SkyMarker[] {
  const { tMs, observer, isHidden } = opts;
  const own = observer.bodyId ?? 'EARTH';
  const positionOf = opts.positionOf ?? ((id: string, t: number): V3 => bodyStateEci(id, t).r);
  const streamed = opts.isStreamed ?? ((id: string, t: number) => isBodyStreamed(id, t));
  const out: SkyMarker[] = [];
  for (const rec of records) {
    const bodyId = bodyOf(rec);
    if (!bodyId || !KINDS.has(rec.kind) || bodyId === own) continue;
    if (rec.kind === 'moon' && rec.bodyId !== own && !streamed(bodyId, tMs)) continue;
    if (isHidden(rec)) continue;
    const r = positionOf(bodyId, tMs);
    if (!r || !Number.isFinite(r[0] + r[1] + r[2])) continue;

    // every scene position is in the axes of date now (core `frameEpoch`), the observer's too: one geometry for all bodies
    const target = r, obs = observer.r, up = observer.up;
    topocentricRaDec(target, obs, tMs, epochOf(bodyId), tmpRd);
    rel[0] = target[0] - obs[0]; rel[1] = target[1] - obs[1]; rel[2] = target[2] - obs[2];
    out.push({
      id: rec.id, name: rec.name, kind: rec.kind,
      raDeg: tmpRd.raDeg, decDeg: tmpRd.decDeg,
      distKm: Math.hypot(rel[0], rel[1], rel[2]),
      hidden: observer.up ? belowHorizon(target, obs, up) : behindEarth(target, obs),
      approx: rec.attrs?.approx === true && !streamed(bodyId, tMs),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// On screen
// ---------------------------------------------------------------------------------------------------------------------

const MOON_ENTITY = bodyEntityId('MOON');

/**
 * Importance of a marker, smaller wins: the Sun (kind `star`) 0, the Moon 1, planets 2, dwarf planets 3, other moons 4. The
 * Moon is told by its entity id (a kind `moon` of the Earth); the other moons rank last whichever planet they belong to.
 */
export function skyRank(m: Pick<SkyMarker, 'id' | 'kind'>): number {
  if (m.kind === 'star') return 0;
  if (m.id === MOON_ENTITY) return 1;
  if (m.kind === 'planet') return 2;
  if (m.kind === 'dwarf_planet') return 3;
  return 4;
}

/** A marker with its screen position, px. */
export interface Placed { marker: SkyMarker; x: number; y: number }

/**
 * Projector: fills `out` with the pixel position of a J2000 RA/Dec and returns false when the point cannot be shown (behind
 * the projection plane). It closes over the view (centre, FOV, rotation), so the declutter needs no Aladin.
 */
export type Project = (raDeg: number, decDeg: number, out: [number, number]) => boolean;

const px: [number, number] = [0, 0];

/**
 * The markers that stay readable: project each, drop those outside the view (more than `LABEL_H` px beyond the viewport), and
 * where two are closer than `LABEL_H` px keep the one of the higher rank (`skyRank`: Sun, Moon, planets, dwarf planets, moons),
 * then the nearer to the observer (no magnitudes are stored: for planets nearer is only a proxy for brighter). Returns the
 * kept ones in rank order, written into `out` (cleared first) so a per-frame caller can reuse the array. `fovDeg` is the
 * view's field of view; a non-positive or non-finite one means the view is not set up yet and nothing is placed.
 */
export function declutter(markers: readonly SkyMarker[], fovDeg: number, viewW: number, viewH: number, project: Project, out: Placed[] = []): Placed[] {
  out.length = 0;
  if (!(fovDeg > 0) || !Number.isFinite(fovDeg)) return out;
  const order = markers.slice().sort((a, b) => skyRank(a) - skyRank(b) || a.distKm - b.distKm || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sep2 = LABEL_H * LABEL_H;
  for (const m of order) {
    if (!project(m.raDeg, m.decDeg, px)) continue;
    const x = px[0], y = px[1];
    if (!(x >= -LABEL_H && x <= viewW + LABEL_H && y >= -LABEL_H && y <= viewH + LABEL_H)) continue;
    let clear = true;
    for (const k of out) {
      const dx = k.x - x, dy = k.y - y;
      if (dx * dx + dy * dy < sep2) { clear = false; break; }
    }
    if (clear) out.push({ marker: m, x, y });
  }
  return out;
}

/** The id of the point nearest to (x, y) within `radiusPx` (inclusive), or null. The first wins a tie. No allocation. */
export function nearestMarker(points: ArrayLike<{ id: string; x: number; y: number }>, x: number, y: number, radiusPx: number): string | null {
  let best: string | null = null, bestD2 = radiusPx * radiusPx;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const dx = p.x - x, dy = p.y - y, d2 = dx * dx + dy * dy;
    if (d2 <= bestD2 && (best === null || d2 < bestD2)) { best = p.id; bestD2 = d2; }
  }
  return best;
}

/**
 * The unit direction, Earth-inertial axes of date, to turn the first-person camera toward a body clicked on the sky map: the
 * J2000 RA/Dec precessed to the date (`precessFromJ2000`, as a vector) and made a direction (`raDecToDir`). Fills `out` when given.
 */
export function lookDirTo(raDegJ2000: number, decDegJ2000: number, tMs: number, out: V3 = [0, 0, 0]): V3 {
  raDecToDir(raDegJ2000, decDegJ2000, out);
  return precessDir(out, tMs, false, out);
}
