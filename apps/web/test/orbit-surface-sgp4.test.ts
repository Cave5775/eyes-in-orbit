import { describe, expect, it } from 'vitest';
import { EntityGraph, type EntityRecord } from '@eio/core';
import { orbitPeriodSec } from '../src/lib/orbit';

const T = Date.parse('2026-11-15T00:00:00Z');
const sat = (id: string, meanMotion: number, ecc: number, anomaly: number): EntityRecord => ({
  id, name: id, kind: 'satellite', bodyId: 'EARTH', aliases: {}, updatedAt: 0,
  provider: {
    type: 'sgp4',
    omm: { OBJECT_NAME: id, EPOCH: '2026-11-15T00:00:00', MEAN_MOTION: meanMotion, ECCENTRICITY: ecc, INCLINATION: 53, RA_OF_ASC_NODE: 0, ARG_OF_PERICENTER: 0, MEAN_ANOMALY: anomaly, NORAD_CAT_ID: 1, BSTAR: 0, MEAN_MOTION_DOT: 0, MEAN_MOTION_DDOT: 0 },
  } as EntityRecord['provider'],
});
const periodOf = (rec: EntityRecord): { r: number; period: number | null } => {
  const g = new EntityGraph();
  g.upsert(rec);
  const s = g.stateIn(rec.id, T, 'EARTH:inertial')!;
  return { r: Math.hypot(...s.r), period: orbitPeriodSec(g, rec, s, T) };
};

describe('SGP4 orbit line clears the Earth', () => {
  it('keeps the line of a normal low orbit', () => {
    expect(periodOf(sat('leo', 15.5, 0.0005, 0)).period).toBeCloseTo((86400 / 15.5), -1);
  });
  it('gives no line to an element set whose perigee is below the surface, though it is high above it now', () => {
    const { r, period } = periodOf(sat('decayed', 15, 0.1, 90)); // perigee about 6250 km from the centre, now on the way up
    expect(r).toBeGreaterThan(6428);
    expect(period).toBeNull();
  });
});
