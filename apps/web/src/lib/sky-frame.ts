import { DEG, J2000_MS, gmstRad } from '@eio/core';
import type { V3 } from './camera';

/**
 * Sky geometry for a ground observatory (pure). The horizontal <-> equatorial functions work in coordinates OF DATE (the mean
 * equator and equinox of the date: the sidereal angle is the MEAN one, no nutation). Catalogue and survey coordinates (Aladin,
 * HiPS) are J2000: `precessToJ2000` / `precessFromJ2000` (IAU 1976, Meeus ch. 21) move between the two; about 22 arcmin in 2026.
 *
 * GMST comes from core `gmstRad`, the IAU 1982 expression (Meeus, Astronomical Algorithms 2nd ed., eq. 12.4; UT1 ~ UTC, error
 * under a second of time). Longitudes are east positive, azimuth is measured from north through east.
 */

export { gmstRad };

const TWO_PI = 2 * Math.PI;
const wrap2Pi = (a: number): number => ((a % TWO_PI) + TWO_PI) % TWO_PI;
const wrap360 = (d: number): number => ((d % 360) + 360) % 360;

/** Local mean sidereal time, radians in [0, 2 pi), for an east longitude in degrees. */
export function lstRad(tMs: number, lonDeg: number): number {
  return wrap2Pi(gmstRad(tMs) + lonDeg * DEG);
}

export interface RaDec { raDeg: number; decDeg: number }
export interface AzEl { azDeg: number; elDeg: number }

/** The point straight overhead: RA is the local sidereal time, Dec the geodetic latitude. */
export function zenithRaDec(tMs: number, latDeg: number, lonDeg: number): RaDec {
  return { raDeg: lstRad(tMs, lonDeg) / DEG, decDeg: latDeg };
}

/** Horizontal coordinates of an RA/Dec seen from a site at `tMs` (no refraction). */
export function raDecToAzEl(raDeg: number, decDeg: number, tMs: number, latDeg: number, lonDeg: number): AzEl {
  const H = lstRad(tMs, lonDeg) - raDeg * DEG; // hour angle
  const dec = decDeg * DEG, lat = latDeg * DEG;
  const sinEl = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H);
  const el = Math.asin(Math.max(-1, Math.min(1, sinEl)));
  // azimuth from north through east
  const az = Math.atan2(-Math.cos(dec) * Math.sin(H), Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H));
  return { azDeg: wrap360(az / DEG), elDeg: el / DEG };
}

/** Inverse of `raDecToAzEl`. */
export function azElToRaDec(azDeg: number, elDeg: number, tMs: number, latDeg: number, lonDeg: number): RaDec {
  const az = azDeg * DEG, el = elDeg * DEG, lat = latDeg * DEG;
  const sinDec = Math.sin(lat) * Math.sin(el) + Math.cos(lat) * Math.cos(el) * Math.cos(az);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const H = Math.atan2(-Math.sin(az) * Math.cos(el), Math.sin(el) * Math.cos(lat) - Math.cos(el) * Math.cos(az) * Math.sin(lat));
  return { raDeg: wrap360((lstRad(tMs, lonDeg) - H) / DEG), decDeg: dec / DEG };
}

/** Sim time is quantised to this step before the zenith is recomputed, so a fast clock does not re-aim the view every frame. */
export const ZENITH_STEP_MS = 5000;

/** `tMs` rounded down to a multiple of ZENITH_STEP_MS: the view re-aims only when this changes. */
export const zenithStep = (tMs: number): number => Math.floor(tMs / ZENITH_STEP_MS) * ZENITH_STEP_MS;

// ---------------------------------------------------------------------------------------------------------------------
// Directions, precession and the parallactic angle
// ---------------------------------------------------------------------------------------------------------------------

const ARCSEC = DEG / 3600;
const MS_PER_JULIAN_CENTURY = 36525 * 86_400_000;

/** RA in [0, 360) and Dec of an equatorial direction (any length; km vector or unit). The zero vector gives RA 0, Dec 0. */
export function dirToRaDec(d: V3): RaDec {
  return { raDeg: wrap360(Math.atan2(d[1], d[0]) / DEG), decDeg: Math.atan2(d[2], Math.hypot(d[0], d[1])) / DEG };
}

/** Unit equatorial direction of an RA/Dec in degrees; `out` is filled when given (no allocation). */
export function raDecToDir(raDeg: number, decDeg: number, out: V3 = [0, 0, 0]): V3 {
  const ra = raDeg * DEG, dec = decDeg * DEG, c = Math.cos(dec);
  out[0] = c * Math.cos(ra);
  out[1] = c * Math.sin(ra);
  out[2] = Math.sin(dec);
  return out;
}

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
export function precessDir(d: V3, tMs: number, toJ2000: boolean, out: V3 = [0, 0, 0]): V3 {
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

/** Mean place of date -> J2000 (IAU 1976 rigorous precession, no nutation, no proper motion). */
export function precessToJ2000(raDeg: number, decDeg: number, tMs: number): RaDec {
  return dirToRaDec(precessDir(raDecToDir(raDeg, decDeg), tMs, true));
}

/** J2000 -> mean place of date; the inverse of `precessToJ2000`. */
export function precessFromJ2000(raDeg: number, decDeg: number, tMs: number): RaDec {
  return dirToRaDec(precessDir(raDecToDir(raDeg, decDeg), tMs, false));
}

/**
 * Parallactic angle, degrees in (-180, 180]: the angle at an object between the direction to the north celestial pole and the
 * direction to the zenith, positive when the object is west of the meridian (hour angle > 0). Meeus, Astronomical Algorithms
 * 2nd ed., ch. 14, eq. 14.1: tan q = sin H / (tan phi cos delta - sin delta cos H), taken with atan2 so the quadrant is right
 * (on the meridian q is 0 when the object is south of the zenith, 180 when it is between the zenith and the pole).
 */
export function parallacticAngleDeg(hourAngleDeg: number, decDeg: number, latDeg: number): number {
  const H = hourAngleDeg * DEG, dec = decDeg * DEG, lat = latDeg * DEG;
  return Math.atan2(Math.sin(H), Math.tan(lat) * Math.cos(dec) - Math.sin(dec) * Math.cos(H)) / DEG;
}
