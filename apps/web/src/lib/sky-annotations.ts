import { DEG, EARTH, bodyEntityId, bodyOf, bodyStateEci, gmstRad, isBodyStreamed, sunPositionEci, type EntityRecord } from '@eio/core';
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
 * pointing"): the Sun and the Moon come from series of the date (`sunPositionEci`, `moonPositionEci`: mean equator and
 * equinox of date), every other body (planets, dwarf planets, moons; fallback Kepler orbits and the Horizons ICRF stream
 * alike) is a J2000 orbit rotated by the J2000 obliquity. `bodyId` is a registry id (`MOON`, not `body-moon`). The Earth is
 * the origin of the frame and has no direction; it is listed as of date, like its axes.
 */
export function epochOf(bodyId: string): Epoch {
  return bodyId === 'SUN' || bodyId === 'MOON' || bodyId === 'EARTH' ? 'date' : 'j2000';
}

const D: V3 = [0, 0, 0];
const S: V3 = [0, 0, 0];
const SP: V3 = [0, 0, 0];

/**
 * The scene position of a J2000 body (planet, dwarf planet, moon) made a true geocentric J2000 position, in place of `out`.
 * The scene builds such a body as `X(J2000) - EarthFromSun`, and `EarthFromSun` is `-sunPositionEci`, a series OF DATE
 * (core `earthInSunFrame`). So the scene vector is `X_J2000 + S_date`, a mix of two epochs; the geocentric J2000 vector is
 * `X_J2000 + S_J2000` with `S_J2000 = precess(S_date)`. This adds the difference `S_J2000 - S_date`: a rotation of the 1 AU
 * Sun vector by the precession since J2000 (about 22 arcmin in 2026), i.e. up to 9.8e5 km, which seen from Earth is at most
 * 0.07 deg for Jupiter (about 5 AU), 0.4 deg for Mars at 1 AU and 1.4 deg for Venus near inferior conjunction (0.27 AU),
 * depending on the geometry (1992 Venus, Meeus 33.a: 0.07 deg). `out`
 * may be `rScene`. Valid for the Earth-inertial scene positions of `epochOf(...) === 'j2000'` bodies only.
 */
export function j2000Geocentric(rScene: V3, tMs: number, out: V3 = [0, 0, 0]): V3 {
  const s = sunPositionEci(tMs);
  S[0] = s[0]; S[1] = s[1]; S[2] = s[2];
  precessDir(S, tMs, true, SP);
  out[0] = rScene[0] + SP[0] - S[0];
  out[1] = rScene[1] + SP[1] - S[1];
  out[2] = rScene[2] + SP[2] - S[2];
  return out;
}

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
const obsJ: V3 = [0, 0, 0];
const upJ: V3 = [0, 0, 0];
const rJ: V3 = [0, 0, 0];
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
 * Planets, dwarf planets and moons go through `j2000Geocentric` first (the scene's mixed epochs, see there), and the
 * observer is precessed to J2000 with them, so every J2000 body is a consistent J2000 geometry.
 */
export function selectBodies(records: Iterable<EntityRecord>, opts: SelectOptions): SkyMarker[] {
  const { tMs, observer, isHidden } = opts;
  const own = observer.bodyId ?? 'EARTH';
  const positionOf = opts.positionOf ?? ((id: string, t: number): V3 => bodyStateEci(id, t).r);
  const streamed = opts.isStreamed ?? ((id: string, t: number) => isBodyStreamed(id, t));
  let haveObsJ = false;
  const out: SkyMarker[] = [];
  for (const rec of records) {
    const bodyId = bodyOf(rec);
    if (!bodyId || !KINDS.has(rec.kind) || bodyId === own) continue;
    if (rec.kind === 'moon' && rec.bodyId !== own && !streamed(bodyId, tMs)) continue;
    if (isHidden(rec)) continue;
    const r = positionOf(bodyId, tMs);
    if (!r || !Number.isFinite(r[0] + r[1] + r[2])) continue;

    const epoch = epochOf(bodyId);
    let target = r, obs = observer.r, up = observer.up;
    if (epoch === 'j2000') {
      if (!haveObsJ) {
        precessDir(observer.r, tMs, true, obsJ);
        if (observer.up) precessDir(observer.up, tMs, true, upJ);
        haveObsJ = true;
      }
      target = j2000Geocentric(r, tMs, rJ);
      obs = obsJ;
      up = observer.up ? upJ : undefined;
    }
    topocentricRaDec(target, obs, tMs, epoch, tmpRd);
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
