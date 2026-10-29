import { describe, expect, it } from 'vitest';
import { EARTH, EntityGraph, bodyEntityRecords, bodyStateEci, moonPositionEci, norm, type Vec3 } from '@eio/core';
import { MAX_DIST_KM } from '../src/lib/camera';
import { computeTelemetry } from '../src/lib/telemetry';
import { mockSatellites } from '../src/mock/generators';
import {
  REF_LABEL, REF_RADIUS_KM, isRegistryBody, refDisplay, refMinDistKm, refPositionEci, refRadiusKm,
  refViewDistKm, relativeToRef, type RefBody,
} from '../src/lib/ref-body';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe('reference bodies', () => {
  it('puts each body centre at its ephemeris position in Earth-inertial coordinates', () => {
    expect(refPositionEci('EARTH', NOW)).toEqual([0, 0, 0]);
    expect(refPositionEci('MOON', NOW)).toEqual(moonPositionEci(NOW));
    const sun = norm(refPositionEci('SUN', NOW));
    expect(sun).toBeGreaterThan(1.45e8);
    expect(sun).toBeLessThan(1.55e8);
  });

  it('re-expresses a point relative to the body centre', () => {
    const p: Vec3 = [7000, 100, -50];
    expect(relativeToRef('EARTH', p, NOW)).toEqual(p);
    const moon = relativeToRef('MOON', p, NOW);
    expect(norm(moon)).toBeGreaterThan(340_000);
    expect(norm(moon)).toBeLessThan(410_000);
    // a point at the Moon's centre is at the origin of the Moon view
    relativeToRef('MOON', refPositionEci('MOON', NOW), NOW).forEach((x) => expect(x).toBe(0));
  });

  it('frames each body and keeps the camera above its surface', () => {
    expect(refViewDistKm('MOON')).toBeGreaterThan(refMinDistKm('MOON'));
    expect(refViewDistKm('SUN')).toBeGreaterThan(refMinDistKm('SUN'));
    expect(refMinDistKm('MOON')).toBeGreaterThan(1737.4);
    // every view can zoom out past the Earth's orbit (1.5e8 km): the camera limit is 1e11 km for all of them
    expect(MAX_DIST_KM).toBeGreaterThan(6e8);
  });
});

describe('reference bodies from the registry (Mars)', () => {
  it('takes any registry body, with the old names unchanged', () => {
    expect(isRegistryBody('MARS')).toBe(true);
    expect(isRegistryBody('XENA')).toBe(false);
    expect(REF_RADIUS_KM.MARS).toBe(3396.19);
    expect(REF_LABEL.MARS).toBe('Mars');
    expect(refRadiusKm('MOON')).toBe(1737.4);
    const asBody: RefBody = 'MARS'; // any string is a RefBody, the literals stay assignable
    expect(refPositionEci(asBody, NOW)).toEqual(bodyStateEci('MARS', NOW).r);
  });

  it('delegates every position to core bodyStateEci (one source of truth)', () => {
    for (const id of ['EARTH', 'MOON', 'SUN', 'MARS']) expect(refPositionEci(id, NOW)).toEqual(bodyStateEci(id, NOW).r);
    expect(refPositionEci('NOPE', NOW)).toEqual([0, 0, 0]);
  });

  it('draws Mars where it is (true distance from the Earth), at its true radius', () => {
    const real = refPositionEci('MARS', NOW);
    expect(norm(real)).toBeGreaterThan(5e7);
    expect(refDisplay('MARS', NOW)).toEqual({ r: real, k: 1 });
  });

  it('frames Mars at 4 radii and keeps the camera above its surface', () => {
    expect(refViewDistKm('MARS')).toBeCloseTo(3396.19 * 4, 6);
    expect(refMinDistKm('MARS')).toBeCloseTo(3396.19 * 1.02, 6);
    expect(refViewDistKm('MARS')).toBeGreaterThan(refMinDistKm('MARS'));
  });

  it('re-expresses a point relative to Mars', () => {
    const c = refPositionEci('MARS', NOW);
    relativeToRef('MARS', c, NOW).forEach((x) => expect(x).toBe(0));
    expect(norm(relativeToRef('MARS', [0, 0, 0], NOW))).toBeCloseTo(norm(c), 3);
  });
});

describe('readouts relative to the reference body', () => {
  const iss = mockSatellites(NOW).find((s) => s.id === 'sat-25544')!;
  const g = new EntityGraph();
  for (const r of bodyEntityRecords()) g.upsert(r); // the frame centre is an entity in the graph
  g.upsert(iss);

  it('adds range and speed relative to the Moon (the body entity as the frame centre)', () => {
    const tel = computeTelemetry(g, iss, NOW, 'body-moon')!;
    const earthState = g.stateIn(iss.id, NOW, 'EARTH:inertial')!;
    const moonState = g.stateIn(iss.id, NOW, 'MOON:inertial')!;
    // position: Earth-relative minus the Moon's position; velocity: minus the Moon's velocity (about 1 km/s)
    const expected = norm(sub(earthState.r, moonPositionEci(NOW)));
    expect(tel.refRangeKm).toBeCloseTo(expected, 3);
    expect(tel.refRangeKm).toBeCloseTo(norm(moonState.r), 3); // the core frame hop gives the same
    expect(tel.refSpeedKmS).toBeGreaterThan(6.5); // 7.7 km/s orbit against a ~1 km/s Moon
    expect(tel.refSpeedKmS).toBeLessThan(8.8);
    // the Earth-based readouts are untouched
    expect(tel.rangeKm).toBeCloseTo(norm(earthState.r), 6);
    expect(tel.rangeKm).toBeLessThan(EARTH.radiusKm + 1000);
  });

  it('adds nothing for the Earth view and puts the ISS near 1 AU from the Sun', () => {
    const earth = computeTelemetry(g, iss, NOW)!;
    expect(earth.refRangeKm).toBeUndefined();
    expect(earth.refSpeedKmS).toBeUndefined();
    const sun = computeTelemetry(g, iss, NOW, 'body-sun')!;
    expect(sun.refRangeKm).toBeGreaterThan(1.45e8);
    expect(sun.refRangeKm).toBeLessThan(1.55e8);
    expect(sun.refSpeedKmS).toBeGreaterThan(25); // the Earth's 29.8 km/s dominates
    expect(sun.refSpeedKmS).toBeLessThan(40);
  });
});

describe('reference bodies are drawn to scale', () => {
  it('draws the Moon, the Sun and the Earth at their true places, radius factor 1', () => {
    expect(refDisplay('MOON', NOW)).toEqual({ r: moonPositionEci(NOW), k: 1 });
    expect(refDisplay('SUN', NOW)).toEqual({ r: refPositionEci('SUN', NOW), k: 1 });
    expect(refDisplay('EARTH', NOW)).toEqual({ r: [0, 0, 0], k: 1 });
  });

  it('frames the Sun at 4 true radii and keeps the camera above its surface', () => {
    expect(refViewDistKm('SUN')).toBe(REF_RADIUS_KM.SUN * 4);
    expect(refViewDistKm('SUN')).toBeGreaterThan(refMinDistKm('SUN'));
    expect(refMinDistKm('SUN')).toBeCloseTo(REF_RADIUS_KM.SUN * 1.02, 6);
  });
});
