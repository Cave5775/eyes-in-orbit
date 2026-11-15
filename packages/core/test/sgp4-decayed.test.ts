import { describe, expect, it } from 'vitest';
import { json2satrec, sgp4 } from 'satellite.js';
import { plausibleSgp4State, Sgp4Provider } from '../src';
import type { Omm } from '../src';

// STARLINK-35837 as a stale CelesTrak snapshot served it (triage #29): a huge drag term, so SGP4 decays it within a week
const STALE: Omm = {
  OBJECT_NAME: 'STARLINK-35837', OBJECT_ID: '2025-280V', EPOCH: '2026-10-27T16:00:03.000096', MEAN_MOTION: 15.22282773,
  ECCENTRICITY: 0.00033607, INCLINATION: 70.0005, RA_OF_ASC_NODE: 109.2101, ARG_OF_PERICENTER: 276.6899, MEAN_ANOMALY: 59.3068,
  EPHEMERIS_TYPE: 0, CLASSIFICATION_TYPE: 'U', NORAD_CAT_ID: 66840, ELEMENT_SET_NO: 999, REV_AT_EPOCH: 563, BSTAR: 0.16376521,
  MEAN_MOTION_DOT: 0.04340616, MEAN_MOTION_DDOT: 0,
} as Omm;
// the same object's current Space-Track set
const CURRENT: Omm = { ...STALE, EPOCH: '2026-11-15T10:38:07.179360', MEAN_MOTION: 15.29589055, BSTAR: 0.00062912, MEAN_MOTION_DOT: 0.00018006, REV_AT_EPOCH: 5370 } as Omm;

const NOW = Date.parse('2026-11-15T18:00:00Z');

describe('decayed SGP4 element sets', () => {
  it('SGP4 itself returns wild finite states with no error flag for the stale set (the bug)', () => {
    const s = json2satrec(STALE as never);
    const o = sgp4(s, (NOW - Date.parse(`${STALE.EPOCH}Z`)) / 60_000);
    const v = o && typeof o.velocity !== 'boolean' ? o.velocity : null;
    expect(v && Math.hypot(v.x, v.y, v.z)).toBeGreaterThan(1000);
  });

  it('the provider gives no state rather than a wild one, minute by minute over 10 hours', () => {
    const p = new Sgp4Provider(STALE);
    for (let m = 0; m < 600; m++) expect(p.stateAt(NOW + m * 60_000)).toBeNull();
  });

  it('a current set still propagates (480 km, 7.6 km/s)', () => {
    const st = new Sgp4Provider(CURRENT).stateAt(NOW);
    expect(st).not.toBeNull();
    const [x, y, z] = st!.r, [vx, vy, vz] = st!.v ?? [0, 0, 0];
    expect(Math.hypot(x, y, z) - 6378).toBeGreaterThan(400);
    expect(Math.hypot(vx, vy, vz)).toBeCloseTo(7.63, 1);
  });

  it('plausibleSgp4State: bound orbits in, escape speed and sub-surface out', () => {
    expect(plausibleSgp4State(6857, 0, 0, 0, 7.63, 0)).toBe(true); // LEO
    expect(plausibleSgp4State(42164, 0, 0, 0, 3.07, 0)).toBe(true); // GEO
    expect(plausibleSgp4State(6857, 0, 0, 0, 10.8, 0)).toBe(false); // escape speed at 480 km is 10.78 km/s
    expect(plausibleSgp4State(6857, 0, 0, 0, 185_925, 0)).toBe(false);
    expect(plausibleSgp4State(6000, 0, 0, 0, 7, 0)).toBe(false);
    expect(plausibleSgp4State(NaN, 0, 0, 0, 7, 0)).toBe(false);
  });
});
