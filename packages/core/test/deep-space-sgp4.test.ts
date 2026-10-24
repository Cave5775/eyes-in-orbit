import { describe, expect, it } from 'vitest';
import { DEG, EARTH, Sgp4Provider, norm, stateToGeodetic, type Omm } from '../src';

/**
 * Non-LEO element sets (orbital period over 225 min uses SDP4, the deep-space branch of satellite.js): a GPS-like MEO set
 * and a GEO set must propagate as well as the LEO ones. Realistic CelesTrak-style values, epoch in 2026.
 */
const EPOCH = '2026-10-20T12:00:00.000000';
const T0 = Date.parse(`${EPOCH}Z`);
const DAY = 86_400_000;

const GPS_OMM: Omm = {
  OBJECT_NAME: 'GPS BIIR-8 (PRN 16)', OBJECT_ID: '2003-005A', EPOCH,
  MEAN_MOTION: 2.0057, ECCENTRICITY: 0.005, INCLINATION: 55.1, RA_OF_ASC_NODE: 243.5,
  ARG_OF_PERICENTER: 61.2, MEAN_ANOMALY: 299.0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 27663, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 8900, BSTAR: 0, MEAN_MOTION_DOT: -0.00000018, MEAN_MOTION_DDOT: 0,
};
const GEO_OMM: Omm = {
  OBJECT_NAME: 'GOES 16', OBJECT_ID: '2016-071A', EPOCH,
  MEAN_MOTION: 1.0027, ECCENTRICITY: 0.0001, INCLINATION: 0.05, RA_OF_ASC_NODE: 88.0,
  ARG_OF_PERICENTER: 220.0, MEAN_ANOMALY: 140.0, EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: 41866, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 3600, BSTAR: 0, MEAN_MOTION_DOT: -0.00000004, MEAN_MOTION_DDOT: 0,
};

const within = (value: number, target: number, frac: number): boolean => Math.abs(value - target) <= target * frac;

describe('SGP4 for medium and geostationary orbits', () => {
  it('GPS-like set: radius about 26,560 km, period about 12 sidereal hours', () => {
    const p = new Sgp4Provider(GPS_OMM);
    expect(within(p.periodMin, 717.9, 0.01)).toBe(true);
    for (let d = -3; d <= 3; d += 0.5) {
      const s = p.stateAt(T0 + d * DAY)!;
      expect(s, `day ${d}`).not.toBeNull();
      expect(s.r.every(Number.isFinite)).toBe(true);
      expect(within(norm(s.r), 26_560, 0.01)).toBe(true);
      // circular orbit speed at that radius is 3.87 km/s
      expect(within(norm(s.v!), 3.87, 0.03)).toBe(true);
    }
  });

  it('GPS-like set: altitude about 20,200 km and latitude bounded by the inclination', () => {
    const p = new Sgp4Provider(GPS_OMM);
    for (let d = -3; d <= 3; d += 0.25) {
      const t = T0 + d * DAY;
      const g = stateToGeodetic(p.stateAt(t)!, t, 'EARTH');
      expect(g.alt).toBeGreaterThan(20_200 - 300);
      expect(g.alt).toBeLessThan(20_200 + 300);
      expect(Math.abs(g.lat / DEG)).toBeLessThanOrEqual(55.2);
    }
    // 26,560 - Earth radius
    expect(within(26_560 - EARTH.radiusKm, 20_182, 0.01)).toBe(true);
  });

  it('GEO set: radius about 42,164 km, period about one sidereal day', () => {
    const p = new Sgp4Provider(GEO_OMM);
    expect(within(p.periodMin, 1436.1, 0.005)).toBe(true);
    for (let d = -3; d <= 3; d += 0.5) {
      const s = p.stateAt(T0 + d * DAY)!;
      expect(s, `day ${d}`).not.toBeNull();
      expect(s.r.every(Number.isFinite)).toBe(true);
      expect(within(norm(s.r), 42_164, 0.01)).toBe(true);
      expect(within(norm(s.v!), 3.07, 0.03)).toBe(true);
    }
  });

  it('GEO set: altitude about 35,786 km, nearly fixed over one longitude', () => {
    const p = new Sgp4Provider(GEO_OMM);
    const lons: number[] = [];
    for (let d = -2; d <= 2; d += 0.25) {
      const t = T0 + d * DAY;
      const g = stateToGeodetic(p.stateAt(t)!, t, 'EARTH');
      expect(g.alt).toBeGreaterThan(35_786 - 150);
      expect(g.alt).toBeLessThan(35_786 + 150);
      expect(Math.abs(g.lat / DEG)).toBeLessThan(0.5);
      lons.push(g.lon / DEG);
    }
    // sampled at 6 h steps the sub-satellite longitude stays within a degree or two
    for (const l of lons) expect(Math.abs(((l - lons[0] + 540) % 360) - 180)).toBeLessThan(3);
  });
});
