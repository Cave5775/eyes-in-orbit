import { describe, expect, it } from 'vitest';
import {
  azElToRaDec, dirToRaDec, lstRad, parallacticAngleDeg, precessDir, precessFromJ2000, precessToJ2000, raDecToAzEl, raDecToDir, zenithRaDec, zenithStep,
} from '../src/lib/sky-frame';
import { J2000_MS, gmstRad } from '@eio/core';

const DEG = Math.PI / 180;
const hms = (h: number, m: number, s: number) => (h + m / 60 + s / 3600) * 15; // degrees

describe('sky-frame', () => {
  it('GMST matches the published Meeus examples (AA 2nd ed. 12.a and 12.b)', () => {
    // 1987-04-10 0h UT: 13h 10m 46.3668s
    expect(gmstRad(Date.UTC(1987, 3, 10)) / DEG).toBeCloseTo(hms(13, 10, 46.3668), 4);
    // 1987-04-10 19h 21m 00s UT: 8h 34m 57.0896s
    expect(gmstRad(Date.UTC(1987, 3, 10, 19, 21, 0)) / DEG).toBeCloseTo(hms(8, 34, 57.0896), 4);
  });

  it('local sidereal time adds the east longitude and wraps', () => {
    const t = Date.UTC(1987, 3, 10, 19, 21, 0);
    expect(lstRad(t, 0) / DEG).toBeCloseTo(gmstRad(t) / DEG, 9);
    const l = lstRad(t, -155.4681) / DEG;
    expect(l).toBeGreaterThanOrEqual(0);
    expect(l).toBeLessThan(360);
    expect(l).toBeCloseTo((((gmstRad(t) / DEG - 155.4681) % 360) + 360) % 360, 9);
  });

  it('the zenith is RA = LST, Dec = latitude, and sits at 90 degrees elevation', () => {
    const t = Date.UTC(2026, 5, 1, 3, 0, 0);
    const z = zenithRaDec(t, -24.627, -70.404);
    expect(z.decDeg).toBe(-24.627);
    expect(z.raDeg).toBeCloseTo(lstRad(t, -70.404) / DEG, 9);
    expect(raDecToAzEl(z.raDeg, z.decDeg, t, -24.627, -70.404).elDeg).toBeCloseTo(90, 6);
  });

  it('Polaris-like pole point: altitude equals the latitude, azimuth north, at any time', () => {
    for (const lat of [19.82, 52.5, -30.2]) {
      for (const h of [0, 5, 13]) {
        const t = Date.UTC(2026, 0, 1, h);
        const p = raDecToAzEl(37.95, lat >= 0 ? 90 : -90, t, lat, 10);
        expect(p.elDeg).toBeCloseTo(Math.abs(lat), 6);
        // the south pole is due south (180), the north pole due north (0 or 360)
        if (lat >= 0) expect(Math.min(p.azDeg, 360 - p.azDeg)).toBeLessThan(1e-6);
        else expect(p.azDeg).toBeCloseTo(180, 6);
      }
    }
    // Polaris itself (RA 2h31m49s, Dec +89 15' 51") is within a degree of the latitude at 52.5 N
    const polaris = raDecToAzEl(hms(2, 31, 49), 89.2642, Date.UTC(2026, 0, 1, 6), 52.5, 13.4);
    expect(Math.abs(polaris.elDeg - 52.5)).toBeLessThan(0.8);
  });

  it('a body on the meridian south of the zenith has azimuth 180 and the textbook altitude', () => {
    const t = Date.UTC(2026, 2, 3, 22);
    const lat = 40, lon = -4;
    const ra = lstRad(t, lon) / DEG;
    const p = raDecToAzEl(ra, 10, t, lat, lon);
    expect(p.azDeg).toBeCloseTo(180, 6);
    expect(p.elDeg).toBeCloseTo(90 - (lat - 10), 6);
  });

  it('azEl and raDec are inverses', () => {
    const t = Date.UTC(2026, 7, 15, 1, 2, 3);
    for (const [az, el] of [[10, 20], [123, 45], [250, 80], [359, 5]]) {
      const r = azElToRaDec(az, el, t, -30.24, -70.75);
      const back = raDecToAzEl(r.raDeg, r.decDeg, t, -30.24, -70.75);
      expect(back.azDeg).toBeCloseTo(az, 6);
      expect(back.elDeg).toBeCloseTo(el, 6);
    }
  });

  it('zenithStep quantises sim time to 5 s', () => {
    expect(zenithStep(12_345)).toBe(10_000);
    expect(zenithStep(10_000)).toBe(10_000);
    expect(zenithStep(14_999)).toBe(10_000);
    expect(zenithStep(15_000)).toBe(15_000);
  });
});

describe('directions', () => {
  it('dirToRaDec / raDecToDir round trip, RA in [0, 360), any length', () => {
    for (const [ra, dec] of [[0, 0], [10, 20], [123.4, -45.6], [200, 89.9], [359.99, -89.5], [270, 0]]) {
      const d = raDecToDir(ra, dec);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 12);
      const back = dirToRaDec([d[0] * 384_400, d[1] * 384_400, d[2] * 384_400]);
      expect(back.raDeg).toBeCloseTo(ra, 9);
      expect(back.decDeg).toBeCloseTo(dec, 9);
      expect(back.raDeg).toBeGreaterThanOrEqual(0);
      expect(back.raDeg).toBeLessThan(360);
    }
  });

  it('the axes: +X is RA 0 Dec 0, +Y is RA 90, +Z is the north pole; a negative Y wraps to 270', () => {
    expect(dirToRaDec([1, 0, 0])).toEqual({ raDeg: 0, decDeg: 0 });
    expect(dirToRaDec([0, 2, 0])).toEqual({ raDeg: 90, decDeg: 0 });
    expect(dirToRaDec([0, -3, 0]).raDeg).toBeCloseTo(270, 12);
    expect(dirToRaDec([0, 0, 5]).decDeg).toBe(90);
    expect(dirToRaDec([0, 0, -5]).decDeg).toBe(-90);
  });

  it('raDecToDir fills the given array without allocating', () => {
    const out: [number, number, number] = [0, 0, 0];
    expect(raDecToDir(90, 0, out)).toBe(out);
    expect(out[1]).toBeCloseTo(1, 12);
  });
});

describe('precession (IAU 1976, Meeus ch. 21)', () => {
  const T_YEAR = J2000_MS + 365.25 * 86_400_000;
  const T_CENT = J2000_MS + 36525 * 86_400_000;
  const arcsec = (deg: number) => deg * 3600;
  const raGap = (a: number, b: number, dec: number) => Math.abs(((a - b + 540) % 360) - 180) * Math.cos(dec * DEG);

  it('is the identity at J2000', () => {
    const p = precessFromJ2000(41.05, 49.23, J2000_MS);
    expect(p.raDeg).toBeCloseTo(41.05, 12);
    expect(p.decDeg).toBeCloseTo(49.23, 12);
  });

  it('the first-year motion at RA 0, Dec 0 is the annual precession m = 46.124 and n = 20.043 arcsec/yr (Meeus ch. 21)', () => {
    // Delta alpha = m + n sin(alpha) tan(delta) = m, Delta delta = n cos(alpha) = n at (0, 0).
    const p = precessFromJ2000(0, 0, T_YEAR);
    expect(arcsec(p.raDeg)).toBeCloseTo(46.124, 1);
    expect(arcsec(p.decDeg)).toBeCloseTo(20.043, 1);
    // at RA 90 deg the declination does not change (cos alpha = 0) and the RA moves by m again
    const q = precessFromJ2000(90, 0, T_YEAR);
    expect(arcsec(q.raDeg - 90)).toBeCloseTo(46.124, 1);
    expect(arcsec(q.decDeg)).toBeCloseTo(0, 1);
  });

  it('the pole of date lies theta from the J2000 pole at RA -zeta in J2000 axes (toward 0 h, toward Polaris)', () => {
    // theta and zeta after one century from the IAU 1976 polynomials (arcsec): the test fixes the direction of the rotations
    const theta = (2004.3109 - 0.42665 - 0.041833) / 3600;
    const zeta = (2306.2181 + 0.30188 + 0.017998) / 3600;
    const pole = precessToJ2000(0, 90, T_CENT);
    expect(pole.decDeg).toBeCloseTo(90 - theta, 9);
    expect(pole.raDeg).toBeCloseTo(360 - zeta, 9);
    // the J2000 pole seen from the date is at RA 180 + z
    const z = (2306.2181 + 1.09468 + 0.018203) / 3600;
    const back = precessFromJ2000(0, 90, T_CENT);
    expect(back.decDeg).toBeCloseTo(90 - theta, 9);
    expect(back.raDeg).toBeCloseTo(180 + z, 9);
  });

  it('J2000 -> date -> J2000 and date -> J2000 -> date are the identity, 1900 to 2100, near the poles too', () => {
    const times = [Date.UTC(1900, 0, 1), Date.UTC(1975, 5, 1), Date.UTC(2026, 10, 14), Date.UTC(2100, 0, 1)];
    for (const t of times) {
      for (const [ra, dec] of [[0, 0], [41.05, 49.23], [200, -60], [359.5, 89.99], [10, -89.99], [180, 0.001]]) {
        const a = precessFromJ2000(ra, dec, t);
        const b = precessToJ2000(a.raDeg, a.decDeg, t);
        expect(raGap(b.raDeg, ra, dec)).toBeLessThan(1e-9);
        expect(b.decDeg).toBeCloseTo(dec, 9);
        const c = precessToJ2000(ra, dec, t);
        const d = precessFromJ2000(c.raDeg, c.decDeg, t);
        expect(raGap(d.raDeg, ra, dec)).toBeLessThan(1e-9);
        expect(d.decDeg).toBeCloseTo(dec, 9);
      }
    }
  });

  it('is a rotation: it keeps lengths and angles, and the in-place call works', () => {
    const t = Date.UTC(2026, 10, 14);
    const a: [number, number, number] = [3, -4, 12];
    const out = precessDir(a, t, false);
    expect(Math.hypot(out[0], out[1], out[2])).toBeCloseTo(13, 9);
    const b: [number, number, number] = [3, -4, 12];
    expect(precessDir(b, t, false, b)).toBe(b);
    expect(b[0]).toBeCloseTo(out[0], 12);
    const u = precessDir([1, 0, 0], t, false), v = precessDir([0, 1, 0], t, false);
    expect(u[0] * v[0] + u[1] * v[1] + u[2] * v[2]).toBeCloseTo(0, 12);
  });

  it('in 2026 the shift on the equator is about 22 arcmin (26.9 years x 46.1 arcsec/yr)', () => {
    const p = precessFromJ2000(0, 0, Date.UTC(2026, 10, 14));
    expect(p.raDeg * 60).toBeGreaterThan(20.5);
    expect(p.raDeg * 60).toBeLessThan(21.2);
  });

  // Meeus's worked example 21.b (theta Persei, J2000 -> 2028 November 13.19 TD) is not transcribed here: its printed digits
  // could not be fetched when this was written, and test values are never taken from memory. Add it from the book.
  it('matches Meeus example 21.b (theta Persei, J2000 to 2028 Nov 13.19 TD)', () => {
    // Meeus, Astronomical Algorithms 2nd ed., example 21.b: the J2000 position after proper motion (alpha0, delta0) precessed
    // to JDE 2462088.69 gives alpha = 41.547214 deg, delta = +49.348483 deg (UTC taken as TT here, as in the code)
    const t = J2000_MS + (2462088.69 - 2451545.0) * 86_400_000;
    const p = precessFromJ2000(41.054063, 49.22775, t);
    expect(p.raDeg).toBeCloseTo(41.547214, 4);
    expect(p.decDeg).toBeCloseTo(49.348483, 4);
    const back = precessToJ2000(p.raDeg, p.decDeg, t);
    expect(back.raDeg).toBeCloseTo(41.054063, 9);
    expect(back.decDeg).toBeCloseTo(49.22775, 9);
  });
});

describe('parallactic angle (Meeus ch. 14, eq. 14.1)', () => {
  it('is 0 on the meridian south of the zenith and 180 between the zenith and the pole', () => {
    expect(parallacticAngleDeg(0, 10, 40)).toBe(0);
    expect(parallacticAngleDeg(0, -50, 40)).toBe(0);
    expect(parallacticAngleDeg(0, 60, 40)).toBeCloseTo(180, 12);
  });

  it('is positive west of the meridian (H > 0) and negative east of it', () => {
    expect(parallacticAngleDeg(30, 10, 40)).toBeGreaterThan(0);
    expect(parallacticAngleDeg(-30, 10, 40)).toBeLessThan(0);
    expect(parallacticAngleDeg(30, 10, 40)).toBeCloseTo(-parallacticAngleDeg(-30, 10, 40), 12);
  });

  it('on the equator at Dec 0 the zenith lies 90 deg east (west star) or west (east star) of north', () => {
    // the celestial equator runs through the zenith, so north is perpendicular to the direction of the zenith
    expect(parallacticAngleDeg(40, 0, 0)).toBeCloseTo(90, 9);
    expect(parallacticAngleDeg(-40, 0, 0)).toBeCloseTo(-90, 9);
  });

  it('satisfies the sine rule of the zenith-pole-star triangle: sin q = cos(lat) sin(H) / cos(altitude)', () => {
    const t = Date.UTC(2026, 2, 3, 22);
    for (const [lat, lon] of [[40, -4], [-24.6, -70.4], [19.8, -155.5]]) {
      for (const [ra, dec] of [[20, 10], [150, -20], [300, 55], [75, -60]]) {
        const hor = raDecToAzEl(ra, dec, t, lat, lon);
        const H = lstRad(t, lon) / DEG - ra;
        const q = parallacticAngleDeg(H, dec, lat);
        const rhs = (Math.cos(lat * DEG) * Math.sin(H * DEG)) / Math.cos(hor.elDeg * DEG);
        expect(Math.sin(q * DEG)).toBeCloseTo(rhs, 9);
      }
    }
  });
});
