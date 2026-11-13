import { DEG, gmstRad } from '@eio/core';

/**
 * Sky geometry for a ground observatory (pure). Equatorial coordinates are of date: the sidereal angle is the MEAN one and
 * precession from J2000 (about 26 arcmin in 2026) is ignored, far below what a wide-field sky view shows.
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
