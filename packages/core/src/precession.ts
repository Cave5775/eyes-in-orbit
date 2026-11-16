import { DEG, J2000_MS, MS_PER_DAY, type Vec3 } from './math';

// IAU 1976 precession between the mean equator and equinox of J2000 and that of the date. Moved here from the web app's
// sky-frame.ts so the core frame hop (frames.ts) and the Sky view use the same maths.

const ARCSEC = DEG / 3600;
const MS_PER_JULIAN_CENTURY = 36525 * MS_PER_DAY;

/**
 * Precession angles zeta, z, theta (radians) from the mean equator and equinox of J2000 to that of the date, IAU 1976 (Lieske
 * et al. 1977; Meeus, Astronomical Algorithms 2nd ed., eq. 21.3, which is the case of a start epoch of J2000: the same
 * polynomials are in SOFA `iauPrec76`). `t` is Julian centuries of 36525 days since J2000; arcsec coefficients:
 *   zeta  = 2306.2181 t + 0.30188 t^2 + 0.017998 t^3
 *   z     = 2306.2181 t + 1.09468 t^2 + 0.018203 t^3
 *   theta = 2004.3109 t - 0.42665 t^2 - 0.041833 t^3
 * The time argument is TT in the formulas; sim time is UTC here (about 69 s, 2e-9 centuries, far below any visible effect).
 */
export function precessionAngles(tMs: number): { zeta: number; z: number; theta: number } {
  const t = (tMs - J2000_MS) / MS_PER_JULIAN_CENTURY;
  return {
    zeta: (((0.017998 * t + 0.30188) * t + 2306.2181) * t) * ARCSEC,
    z: (((0.018203 * t + 1.09468) * t + 2306.2181) * t) * ARCSEC,
    theta: (((-0.041833 * t - 0.42665) * t + 2004.3109) * t) * ARCSEC,
  };
}

/**
 * Rotate an equatorial direction between the mean equator and equinox of J2000 and that of the date at `tMs` (rigorous
 * Meeus ch. 21 method: R3(+z) tilt(theta) R3(+zeta), i.e. eq. 21.4 in vector form). `toJ2000` false: J2000 -> of date; true: the
 * inverse (the transpose). Works on any length and writes into `out` (may be the input).
 */
export function precessDir(d: Vec3, tMs: number, toJ2000: boolean, out: Vec3 = [0, 0, 0]): Vec3 {
  const k = trigAt(tMs);
  // J2000 -> date: R3(+z) tilt(theta) R3(+zeta); the inverse is the transpose (angles negated, order reversed)
  const cf = toJ2000 ? k.cz : k.cZeta, sf = toJ2000 ? -k.sz : k.sZeta;
  const ct = k.cTheta, st = toJ2000 ? -k.sTheta : k.sTheta;
  const cl = toJ2000 ? k.cZeta : k.cz, sl = toJ2000 ? -k.sZeta : k.sz;
  const x1 = cf * d[0] - sf * d[1], y1 = sf * d[0] + cf * d[1], z1 = d[2];
  const x2 = ct * x1 - st * z1, z2 = st * x1 + ct * z1;
  out[0] = cl * x2 - sl * y1;
  out[1] = sl * x2 + cl * y1;
  out[2] = z2;
  return out;
}

/** cos and sin of the three angles for one time: a frame hop rotates the position and the velocity (and a mesh three columns) at the same `tMs`, so the last time is kept. */
let cached: { t: number; cZeta: number; sZeta: number; cz: number; sz: number; cTheta: number; sTheta: number } | null = null;
function trigAt(tMs: number) {
  if (cached && cached.t === tMs) return cached;
  const { zeta, z, theta } = precessionAngles(tMs);
  cached = { t: tMs, cZeta: Math.cos(zeta), sZeta: Math.sin(zeta), cz: Math.cos(z), sz: Math.sin(z), cTheta: Math.cos(theta), sTheta: Math.sin(theta) };
  return cached;
}
