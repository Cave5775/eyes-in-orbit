import { J2000_MS, Vec3, wrap2Pi } from './math';
import type { KeplerElements } from './types';

/** Solve Kepler's equation M = E - e sin E for E (elliptical orbits). */
export function solveKepler(m: number, e: number): number {
  const M = wrap2Pi(m);
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 30; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-12) break;
  }
  return E;
}

/** Two-body propagation. gm in km^3/s^2. Returns km, km/s in the parent's inertial frame. */
export function keplerState(el: KeplerElements, gm: number, tMs: number): { r: Vec3; v: Vec3 } {
  const n = Math.sqrt(gm / (el.a * el.a * el.a));
  const dt = (tMs - el.epochMs) / 1000;
  const E = solveKepler(el.m0 + n * dt, el.e);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const b = Math.sqrt(1 - el.e * el.e);

  // perifocal coordinates
  const x = el.a * (cosE - el.e);
  const y = el.a * b * sinE;
  const rmag = el.a * (1 - el.e * cosE);
  const k = (Math.sqrt(gm * el.a)) / rmag;
  const vx = -k * sinE;
  const vy = k * b * cosE;

  // perifocal -> inertial: Rz(-raan) Rx(-i) Rz(-argp)
  const cO = Math.cos(el.raan), sO = Math.sin(el.raan);
  const ci = Math.cos(el.i), si = Math.sin(el.i);
  const cw = Math.cos(el.argp), sw = Math.sin(el.argp);
  const m11 = cO * cw - sO * sw * ci, m12 = -cO * sw - sO * cw * ci;
  const m21 = sO * cw + cO * sw * ci, m22 = -sO * sw + cO * cw * ci;
  const m31 = sw * si, m32 = cw * si;

  return {
    r: [m11 * x + m12 * y, m21 * x + m22 * y, m31 * x + m32 * y],
    v: [m11 * vx + m12 * vy, m21 * vx + m22 * vy, m31 * vx + m32 * vy],
  };
}

/**
 * Inverse of `keplerState`: osculating elliptical elements from a position/velocity pair (km, km/s) in the parent's
 * inertial frame, with the mean anomaly referred to `epochMs`. Feeding the result to `keplerState` reproduces the state.
 *
 * Singular cases get the usual conventions, chosen so that `keplerState` still reproduces the state: with no node line
 * (equatorial orbit) `raan` is 0 and the node frame is the x axis; with no periapsis (circular orbit) `argp` is 0 and the
 * anomaly is measured from the node (or the x axis), so `m0` is then the argument of latitude (true longitude).
 * Throws a RangeError for parabolic and hyperbolic states (`KeplerElements` cannot represent them) and degenerate ones.
 */
export function elementsFromState(r: Vec3, v: Vec3, gm: number, epochMs: number): KeplerElements {
  const rmag = Math.hypot(r[0], r[1], r[2]);
  const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  if (!(rmag > 0)) throw new RangeError('elementsFromState: zero position');
  const invA = 2 / rmag - v2 / gm;
  if (!(invA > 1e-12)) throw new RangeError('elementsFromState: state is not on a bound (elliptical) orbit');
  const a = 1 / invA;

  const h: Vec3 = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
  const hmag = Math.hypot(h[0], h[1], h[2]);
  if (!(hmag > 0)) throw new RangeError('elementsFromState: rectilinear state');

  // eccentricity vector, points at periapsis
  const rv = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
  const kv = v2 - gm / rmag;
  const ev: Vec3 = [(kv * r[0] - rv * v[0]) / gm, (kv * r[1] - rv * v[1]) / gm, (kv * r[2] - rv * v[2]) / gm];
  const e = Math.min(Math.hypot(ev[0], ev[1], ev[2]), 1 - 1e-12);

  // node line n = z x h; atan2 keeps the inclination well conditioned near 0 and pi
  const nmag = Math.hypot(h[0], h[1]);
  const i = Math.atan2(nmag, h[2]);
  const raan = nmag > 1e-10 * hmag ? wrap2Pi(Math.atan2(h[0], -h[1])) : 0;

  // node-frame axes (argp = 0), as in keplerState: P0 toward the ascending node, Q0 completing the plane
  const cO = Math.cos(raan), sO = Math.sin(raan), ci = Math.cos(i), si = Math.sin(i);
  const p0: Vec3 = [cO, sO, 0];
  const q0: Vec3 = [-sO * ci, cO * ci, si];
  const dot3 = (x: Vec3, y: Vec3): number => x[0] * y[0] + x[1] * y[1] + x[2] * y[2];

  const argp = e > 1e-9 ? wrap2Pi(Math.atan2(dot3(ev, q0), dot3(ev, p0))) : 0;
  const cw = Math.cos(argp), sw = Math.sin(argp);
  const p: Vec3 = [cw * p0[0] + sw * q0[0], cw * p0[1] + sw * q0[1], cw * p0[2] + sw * q0[2]];
  const q: Vec3 = [-sw * p0[0] + cw * q0[0], -sw * p0[1] + cw * q0[1], -sw * p0[2] + cw * q0[2]];

  const nu = Math.atan2(dot3(r, q), dot3(r, p));
  const E = 2 * Math.atan2(Math.sqrt(1 - e) * Math.sin(nu / 2), Math.sqrt(1 + e) * Math.cos(nu / 2));
  return { a, e, i, raan, argp, m0: wrap2Pi(E - e * Math.sin(E)), epochMs };
}

export { J2000_MS };
