import { describe, expect, it } from 'vitest';
import {
  AU_KM, DEG, OBLIQUITY_J2000, convert, eclipticToEquatorial, moonPositionEci, moonStateEci, norm, sunDirectionEci, sunDistanceKm,
  sunPositionEci, type Vec3,
} from '../src';

const angleDeg = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (norm(a) * norm(b))))) / DEG;
const toEcliptic = (v: Vec3): Vec3 => eclipticToEquatorial(v, -OBLIQUITY_J2000);

describe('Sun', () => {
  it('has a position along its direction at about 1 AU, nearest in January', () => {
    const jan = Date.UTC(2024, 0, 3), jul = Date.UTC(2024, 6, 5);
    expect(sunDistanceKm(jan)).toBeLessThan(sunDistanceKm(jul));
    expect(sunDistanceKm(jan) / AU_KM).toBeCloseTo(0.983, 2);
    expect(sunDistanceKm(jul) / AU_KM).toBeCloseTo(1.017, 2);
    const p = sunPositionEci(jul), d = sunDirectionEci(jul);
    expect(angleDeg(p, d)).toBeLessThan(1e-9);
    expect(norm(p)).toBeCloseTo(sunDistanceKm(jul), 3);
  });

  it('agrees with the Sun implied by the Earth orbit in the body registry (the frame hop)', () => {
    for (const t of [Date.UTC(2000, 0, 1, 12), Date.UTC(2013, 5, 21), Date.UTC(2026, 9, 23), Date.UTC(2030, 2, 20)]) {
      const hop = convert({ frame: 'SUN:inertial', r: [0, 0, 0] }, 'EARTH:inertial', t).r;
      expect(angleDeg(hop, sunDirectionEci(t))).toBeLessThan(0.6);
      expect(norm(hop) / sunDistanceKm(t)).toBeGreaterThan(0.99);
      expect(norm(hop) / sunDistanceKm(t)).toBeLessThan(1.01);
    }
  });

  it('puts the Sun on the equator at the equinoxes and 23.4 degrees north at the June solstice', () => {
    const march = sunDirectionEci(Date.UTC(2024, 2, 20, 3, 6));
    expect(Math.asin(march[2]) / DEG).toBeCloseTo(0, 0);
    const june = sunDirectionEci(Date.UTC(2024, 5, 20, 20, 51));
    expect(Math.asin(june[2]) / DEG).toBeCloseTo(23.44, 1);
  });
});

describe('Moon', () => {
  it('matches the Meeus worked example (1992-04-12 0h) within the low-precision tolerance', () => {
    const t = Date.UTC(1992, 3, 12);
    const r = moonPositionEci(t);
    const e = toEcliptic(r);
    const lon = Math.atan2(e[1], e[0]) / DEG, lat = Math.asin(e[2] / norm(e)) / DEG;
    expect(Math.abs(lon - 133.1627)).toBeLessThan(0.5);
    expect(Math.abs(lat - -3.2291)).toBeLessThan(0.4);
    expect(Math.abs(norm(r) - 368409.7)).toBeLessThan(3000);
  });

  it('is new near the 2000-01-06 new moon and full near the 2000-01-21 full moon', () => {
    const neu = Date.UTC(2000, 0, 6, 18, 14), full = Date.UTC(2000, 0, 21, 4, 41);
    expect(angleDeg(moonPositionEci(neu), sunDirectionEci(neu))).toBeLessThan(2);
    expect(angleDeg(moonPositionEci(full), sunDirectionEci(full))).toBeGreaterThan(178);
  });

  it('stays between perigee and apogee distance and goes around in about 27.3 days', () => {
    const t0 = Date.UTC(2026, 0, 1);
    let min = Infinity, max = 0;
    for (let h = 0; h < 24 * 400; h += 6) {
      const d = norm(moonPositionEci(t0 + h * 3600_000));
      min = Math.min(min, d);
      max = Math.max(max, d);
    }
    expect(min).toBeGreaterThan(354_000);
    expect(min).toBeLessThan(366_000);
    expect(max).toBeGreaterThan(400_000);
    expect(max).toBeLessThan(408_000);
    // direction returns to (almost) the same place after one sidereal month
    const a = moonPositionEci(t0), b = moonPositionEci(t0 + 27.321661 * 86400_000);
    expect(angleDeg(a, b)).toBeLessThan(6); // the ascending node and apsides drift, so not exactly zero
  });

  it('moves about 1 km/s relative to the Earth', () => {
    const s = moonStateEci(Date.UTC(2026, 5, 1));
    expect(norm(s.v)).toBeGreaterThan(0.9);
    expect(norm(s.v)).toBeLessThan(1.15);
  });

  it('is what the Moon-inertial to Earth-inertial frame hop uses', () => {
    const t = Date.UTC(2026, 9, 23, 12);
    const hop = convert({ frame: 'MOON:inertial', r: [0, 0, 0], v: [0, 0, 0] }, 'EARTH:inertial', t);
    const direct = moonStateEci(t);
    hop.r.forEach((x, i) => expect(x).toBeCloseTo(direct.r[i], 6));
    hop.v!.forEach((x, i) => expect(x).toBeCloseTo(direct.v[i], 9));
    const back = convert(hop, 'MOON:inertial', t);
    back.r.forEach((x) => expect(Math.abs(x)).toBeLessThan(1e-6));
  });

  it('hops Mars to the Moon the same way whether the path goes via the Sun or via the Earth', () => {
    const t = Date.UTC(2026, 9, 23);
    const viaSun = convert({ frame: 'MARS:inertial', r: [0, 0, 0] }, 'MOON:inertial', t).r;
    const viaEarth = convert(convert({ frame: 'MARS:inertial', r: [0, 0, 0] }, 'EARTH:inertial', t), 'MOON:inertial', t).r;
    viaSun.forEach((x, i) => expect(x).toBeCloseTo(viaEarth[i], 3));
  });
});
