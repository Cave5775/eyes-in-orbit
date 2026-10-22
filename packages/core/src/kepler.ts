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

export { J2000_MS };
