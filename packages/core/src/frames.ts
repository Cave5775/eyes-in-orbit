import { Body, BodyEphemerisData, BodyRegistry, bodyPeriodSec, defaultBodies } from './bodies';
import { SampledProvider } from './providers/sampled';
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
  const parent = bodies.get(body.parentId);
  const s = keplerState(body.orbit, parent.gm, tMs);
  // heliocentric elements are ecliptic; all inertial frames use the equatorial axes (what `sunDirectionEci` is expressed in)
  if (body.orbitPlane === 'ecliptic') return { r: eclipticToEquatorial(s.r), v: eclipticToEquatorial(s.v) };
  // a moon's elements are referred to its planet's equator: rotate them into the shared equatorial axes
  if (body.orbitPlane === 'equator' && parent.rotation.kind === 'linear') {
    const m = equatorToInertialMatrix(parent.rotation);
    return { r: mulMV(m, s.r), v: mulMV(m, s.v) };
  }
  return s;
}

/**
 * Matrix taking vectors in the equatorial axes of a body (z along its IAU pole, x along the node of its equator on the ICRF
 * equator) to the shared inertial axes: the transpose of the pole part of `inertialToFixedMatrix`, `Rx(90deg - dec) Rz(ra + 90deg)`.
 */
export function equatorToInertialMatrix(rot: Extract<Body['rotation'], { kind: 'linear' }>): Mat3 {
  return transpose(mulMM(rotX((90 - rot.poleDecDeg) * DEG), rotZ((rot.poleRaDeg + 90) * DEG)));
}

/**
 * How long the correction after the end of a sample window takes to fade out, as a fraction of the body's orbital period
 * (a quarter: the orbit is back on the plain Kepler curve a quarter of a revolution from the joint). The streamed data and
 * the Kepler fallback disagree by up to 3e5 km (Mars) to 6e6 km (Ceres) at the window edge; outside the window the fallback
 * is shifted by that difference, weighted by `1 - smoothstep(dt / fade)`, so the orbit line is continuous through the joint
 * in position AND velocity (the smoothstep has zero slope at both ends, so the velocity at the edge is the streamed one),
 * and far from the window the error tends to the plain Kepler error.
 */
export const STREAM_FADE_PERIOD_FRACTION = 0.25;
/** Fade length, s, for a body without a Kepler period (nothing to take a fraction of): one Julian year. */
export const STREAM_FADE_FALLBACK_SEC = 365.25 * 86400;

/**
 * Feed a body a sample stream (JPL Horizons states relative to its parent, `<PARENT>:inertial`, km and km/s): the registry
 * body's `ephemeris` becomes Hermite interpolation of the samples inside their window and the body's registered ephemeris or
 * Kepler orbit outside it, shifted by the streamed-minus-Kepler difference at the nearest window edge and fading to the plain
 * orbit over `STREAM_FADE_PERIOD_FRACTION` of a period (`STREAM_FADE_PERIOD_FRACTION`: no kink in the orbit line at the joint), so the body, the objects that orbit it and every frame hop through it agree. Returns false (and
 * changes nothing) for a body without a parent, a frame that is not the parent's inertial frame, or fewer than two samples.
 * `data === undefined` removes the stream.
 */
export function setBodyStream(id: string, data: BodyEphemerisData | undefined, bodies: BodyRegistry = defaultBodies): boolean {
  if (!data) {
    bodies.setEphemeris(id, undefined);
    return true;
  }
  const body = bodies.get(id);
  if (!body.parentId || data.frame !== `${body.parentId}:inertial` || data.samples.length < 2) return false;
  const sampled = new SampledProvider(data.frame, data.samples);
  const base = { ...body, ephemeris: bodies.baseEphemerisOf(id) };
  const fallback = (tMs: number) => bodyStateInParent(base, tMs, bodies) ?? { r: [0, 0, 0] as Vec3, v: [0, 0, 0] as Vec3 };
  const range = sampled.validRange as [number, number];
  const period = bodyPeriodSec(base, bodies);
  const fadeMs = (period && period > 0 ? period * STREAM_FADE_PERIOD_FRACTION : STREAM_FADE_FALLBACK_SEC) * 1000;
  // streamed minus fallback at each window edge: [start, end] x [dr, dv]
  const edge = range.map((te) => {
    const s = sampled.stateAt(te), k = fallback(te);
    return s && s.v ? { dr: sub(s.r, k.r), dv: sub(s.v, k.v) } : { dr: [0, 0, 0] as Vec3, dv: [0, 0, 0] as Vec3 };
  });
  bodies.setEphemeris(id, (tMs) => {
    const s = sampled.stateAt(tMs);
    if (s && s.v) return { r: s.r, v: s.v };
    const k = fallback(tMs);
    const before = tMs < range[0];
    const e = before ? edge[0] : edge[1];
    const x = Math.abs(tMs - range[before ? 0 : 1]) / fadeMs; // 0 at the edge, 1 where the correction is gone
    if (!(x < 1)) return k;
    // w = 1 - smoothstep(x); dw/dt has the sign of the direction away from the window, per second
    const w = 1 - x * x * (3 - 2 * x);
    const dw = ((before ? 1 : -1) * 6 * x * (1 - x)) / (fadeMs / 1000);
    return { r: add(k.r, [e.dr[0] * w, e.dr[1] * w, e.dr[2] * w]), v: add(k.v, [e.dv[0] * w + e.dr[0] * dw, e.dv[1] * w + e.dr[1] * dw, e.dv[2] * w + e.dr[2] * dw]) };
  }, data);
  return true;
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
