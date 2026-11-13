import { describe, expect, it } from 'vitest';
import { azElToRaDec, lstRad, raDecToAzEl, zenithRaDec, zenithStep } from '../src/lib/sky-frame';
import { gmstRad } from '@eio/core';

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
