import { Body, BodyRegistry, defaultBodies } from './bodies';
import { eclipticToEquatorial, moonStateEci, sunPositionEci } from './ephemeris';
import { keplerState } from './kepler';
import {
  DEG, J2000_MS, Mat3, MS_PER_DAY, Vec3, add, mulMM, mulMV, rotX, rotZ, sub, transpose, wrap2Pi,
} from './math';
import type { FrameId, FrameKind, StateVector } from './types';

export function parseFrame(f: FrameId): { bodyId: string; kind: FrameKind } {
  const i = f.lastIndexOf(':');
  return { bodyId: f.slice(0, i), kind: f.slice(i + 1) as FrameKind };
}

export const frameId = (bodyId: string, kind: FrameKind): FrameId => `${bodyId}:${kind}`;

/** Greenwich mean sidereal time, radians (UT1 ~ UTC). */
export function gmstRad(tMs: number): number {
  const d = (tMs - J2000_MS) / MS_PER_DAY;
  const T = d / 36525;
  const deg = 280.46061837 + 360.98564736629 * d + 0.000387933 * T * T - (T * T * T) / 38710000;
  return wrap2Pi(deg * DEG);
}

/** Matrix taking inertial-frame vectors to body-fixed vectors. */
export function inertialToFixedMatrix(body: Body, tMs: number): Mat3 {
  if (body.rotation.kind === 'gmst') return rotZ(gmstRad(tMs));
  const r = body.rotation;
  const d = (tMs - J2000_MS) / MS_PER_DAY;
  const w = wrap2Pi((r.w0Deg + r.rateDegPerDay * d) * DEG);
  // IAU: R = Rz(W) Rx(90deg - dec) Rz(ra + 90deg)
  return mulMM(rotZ(w), mulMM(rotX((90 - r.poleDecDeg) * DEG), rotZ((r.poleRaDeg + 90) * DEG)));
}

/** Rotation rate of the body, rad/s (used for fixed-frame velocity terms). */
export function bodyAngularRate(body: Body): number {
  if (body.rotation.kind === 'gmst') return (360.98564736629 * DEG) / 86400;
  return (body.rotation.rateDegPerDay * DEG) / 86400;
}

/** Position of `body` relative to its parent in the parent's inertial frame, or null for the root. */
export function bodyStateInParent(
  body: Body,
  tMs: number,
  bodies: BodyRegistry = defaultBodies,
): { r: Vec3; v: Vec3 } | null {
  if (!body.parentId) return null;
  if (body.ephemeris) return body.ephemeris(tMs);
  if (!body.orbit) return null;
  const s = keplerState(body.orbit, bodies.get(body.parentId).gm, tMs);
  // heliocentric elements are ecliptic; all inertial frames use the equatorial axes (what `sunDirectionEci` is expressed in)
  return body.orbitPlane === 'ecliptic' ? { r: eclipticToEquatorial(s.r), v: eclipticToEquatorial(s.v) } : s;
}

/** Convert a state into `to`. Handles inertial<->fixed and hops across body inertial frames. */
export function convert(
  s: StateVector,
  to: FrameId,
  tMs: number,
  bodies: BodyRegistry = defaultBodies,
): StateVector {
  if (s.frame === to) return s;
  const from = parseFrame(s.frame);
  const dst = parseFrame(to);

  let cur: StateVector = s;

  // 1. bring to inertial of the source body
  if (from.kind === 'fixed') cur = fixedToInertial(cur, bodies.get(from.bodyId), tMs);

  // 2. hop between bodies' inertial frames (all inertial frames share the equatorial axes)
  if (from.bodyId !== dst.bodyId) cur = hopInertial(cur, from.bodyId, dst.bodyId, tMs, bodies);

  // 3. to the destination kind
  if (dst.kind === 'fixed') cur = inertialToFixed(cur, bodies.get(dst.bodyId), tMs);
  return cur;
}

function inertialToFixed(s: StateVector, body: Body, tMs: number): StateVector {
  const m = inertialToFixedMatrix(body, tMs);
  const r = mulMV(m, s.r);
  let v: Vec3 | undefined;
  if (s.v) {
    const w = bodyAngularRate(body);
    const vi = mulMV(m, s.v);
    // v_fixed = R v_inertial - omega x r_fixed  (omega along +Z of fixed frame for gmst bodies)
    v = [vi[0] + w * r[1], vi[1] - w * r[0], vi[2]];
  }
  return { ...s, frame: frameId(body.id, 'fixed'), r, v };
}

function fixedToInertial(s: StateVector, body: Body, tMs: number): StateVector {
  const m = transpose(inertialToFixedMatrix(body, tMs));
  let v: Vec3 | undefined;
  if (s.v) {
    const w = bodyAngularRate(body);
    v = mulMV(m, [s.v[0] - w * s.r[1], s.v[1] + w * s.r[0], s.v[2]]);
  }
  return { ...s, frame: frameId(body.id, 'inertial'), r: mulMV(m, s.r), v };
}

function hopInertial(s: StateVector, fromId: string, toId: string, tMs: number, bodies: BodyRegistry): StateVector {
  // Express state relative to the common ancestor, then back down.
  const up = bodies.lineage(fromId);
  const down = bodies.lineage(toId);
  const downIds = new Set(down.map((b) => b.id));
  const common = up.find((b) => downIds.has(b.id));
  if (!common) throw new Error(`No common ancestor for ${fromId} and ${toId}`);

  let r = s.r;
  let v = s.v;
  for (const b of up) {
    if (b.id === common.id) break;
    const o = bodyStateInParent(b, tMs, bodies);
    if (!o) break;
    r = add(r, o.r);
    if (v) v = add(v, o.v);
  }
  for (const b of down) {
    if (b.id === common.id) break;
    const o = bodyStateInParent(b, tMs, bodies);
    if (!o) break;
    r = sub(r, o.r);
    if (v) v = sub(v, o.v);
  }
  return { ...s, frame: frameId(toId, 'inertial'), r, v };
}

/**
 * State of a registry body in `EARTH:inertial` at `tMs`: the same positions the scene draws. Earth is the origin (zero),
 * the Sun is `sunPositionEci` (velocity by central difference), the Moon `moonStateEci`, any other body (Mars, ...) the
 * hop of its own inertial origin into `EARTH:inertial`.
 */
export function bodyStateEci(id: string, tMs: number, bodies: BodyRegistry = defaultBodies): StateVector {
  const frame: FrameId = 'EARTH:inertial';
  if (id === 'EARTH') return { frame, r: [0, 0, 0], v: [0, 0, 0] };
  if (id === 'SUN') {
    const half = 30_000;
    const a = sunPositionEci(tMs - half), b = sunPositionEci(tMs + half);
    const span = (2 * half) / 1000; // seconds
    return { frame, r: sunPositionEci(tMs), v: [(b[0] - a[0]) / span, (b[1] - a[1]) / span, (b[2] - a[2]) / span] };
  }
  if (id === 'MOON') {
    const s = moonStateEci(tMs);
    return { frame, r: s.r, v: s.v };
  }
  return convert({ frame: frameId(id, 'inertial'), r: [0, 0, 0], v: [0, 0, 0] }, frame, tMs, bodies);
}

// ---------------------------------------------------------------- geodetic

export interface Geodetic {
  /** radians */
  lat: number;
  lon: number;
  /** km above the reference ellipsoid */
  alt: number;
}

export function geodeticToFixed(g: Geodetic, body: Body): Vec3 {
  const a = body.radiusKm;
  const e2 = body.flattening * (2 - body.flattening);
  const sl = Math.sin(g.lat), cl = Math.cos(g.lat);
  const N = a / Math.sqrt(1 - e2 * sl * sl);
  return [
    (N + g.alt) * cl * Math.cos(g.lon),
    (N + g.alt) * cl * Math.sin(g.lon),
    (N * (1 - e2) + g.alt) * sl,
  ];
}

export function fixedToGeodetic(r: Vec3, body: Body): Geodetic {
  const a = body.radiusKm;
  const e2 = body.flattening * (2 - body.flattening);
  const p = Math.hypot(r[0], r[1]);
  const lon = Math.atan2(r[1], r[0]);
  let lat = Math.atan2(r[2], p * (1 - e2));
  let alt = 0;
  for (let i = 0; i < 6; i++) {
    const sl = Math.sin(lat);
    const N = a / Math.sqrt(1 - e2 * sl * sl);
    alt = Math.abs(lat) < 1.4 ? p / Math.cos(lat) - N : r[2] / sl - N * (1 - e2);
    lat = Math.atan2(r[2], p * (1 - (e2 * N) / (N + alt)));
  }
  return { lat, lon, alt };
}

/** East/North/Up basis vectors (in body-fixed coordinates) at a geodetic location. */
export function enuBasis(lat: number, lon: number): { e: Vec3; n: Vec3; u: Vec3 } {
  const sl = Math.sin(lat), cl = Math.cos(lat), so = Math.sin(lon), co = Math.cos(lon);
  return {
    e: [-so, co, 0],
    n: [-sl * co, -sl * so, cl],
    u: [cl * co, cl * so, sl],
  };
}

/** Convenience: any state -> geodetic on the given body. */
export function stateToGeodetic(s: StateVector, tMs: number, bodyId: string, bodies: BodyRegistry = defaultBodies): Geodetic {
  const fixed = convert(s, frameId(bodyId, 'fixed'), tMs, bodies);
  return fixedToGeodetic(fixed.r, bodies.get(bodyId));
}
