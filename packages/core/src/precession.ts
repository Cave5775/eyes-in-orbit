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
  const { zeta, z, theta } = precessionAngles(tMs);
  const first = toJ2000 ? -z : zeta, last = toJ2000 ? -zeta : z, th = toJ2000 ? -theta : theta;
  let c = Math.cos(first), s = Math.sin(first);
  const x1 = c * d[0] - s * d[1], y1 = s * d[0] + c * d[1], z1 = d[2];
  c = Math.cos(th); s = Math.sin(th);
  const x2 = c * x1 - s * z1, z2 = s * x1 + c * z1;
  c = Math.cos(last); s = Math.sin(last);
  out[0] = c * x2 - s * y1;
  out[1] = s * x2 + c * y1;
  out[2] = z2;
  return out;
}
