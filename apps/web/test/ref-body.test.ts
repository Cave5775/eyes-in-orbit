import { describe, expect, it } from 'vitest';
import { EARTH, EntityGraph, moonPositionEci, norm, type Vec3 } from '@eio/core';
import { bodyCentre } from '../src/lib/frame';
import { computeTelemetry } from '../src/lib/telemetry';
import { mockSatellites } from '../src/mock/generators';
import {
  REF_BODIES, REF_RADIUS_KM, isRefBody, refDisplay, refMaxDistKm, refMinDistKm, refPositionEci, refViewDistKm, relativeToRef,
} from '../src/lib/ref-body';
import { SHELL_THRESHOLD_KM, shellRadius } from '../src/lib/deepspace';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe('reference bodies', () => {
  it('knows the Earth, Moon and Sun and rejects anything else', () => {
    expect(REF_BODIES).toEqual(['EARTH', 'MOON', 'SUN']);
    expect(isRefBody('MOON')).toBe(true);
    expect(isRefBody('MARS')).toBe(false);
    expect(isRefBody(undefined)).toBe(false);
  });

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
    // the Sun view has to reach the Earth's orbit; the other views keep the distance scale's limit
    expect(refMaxDistKm('SUN', 3e7, 'true')).toBeGreaterThan(1.5e8);
    expect(refMaxDistKm('MOON', 3e7)).toBe(3e7);
    expect(refMaxDistKm('SUN', 1e11, 'true')).toBe(1e11);
    // the compressed Sun is only ~3e6 km out: no need for the 6e8 zoom
    expect(refMaxDistKm('SUN', 3e7, 'compressed')).toBe(3e7);
  });
});

describe('readouts relative to the reference body', () => {
  const iss = mockSatellites(NOW).find((s) => s.id === 'sat-25544')!;
  const g = new EntityGraph();
  g.upsert(iss);

  it('adds range and speed relative to the Moon through the core frame hop', () => {
    const tel = computeTelemetry(g, iss, NOW, bodyCentre('MOON'))!;
    const earthState = g.stateIn(iss.id, NOW, 'EARTH:inertial')!;
    const moonState = g.stateIn(iss.id, NOW, 'MOON:inertial')!;
    // position: Earth-relative minus the Moon's position; velocity: minus the Moon's velocity (about 1 km/s)
    const expected = norm(sub(earthState.r, moonPositionEci(NOW)));
    expect(tel.refRangeKm).toBeCloseTo(expected, 3);
    expect(tel.refRangeKm).toBe(norm(moonState.r));
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
    const sun = computeTelemetry(g, iss, NOW, bodyCentre('SUN'))!;
    expect(sun.refRangeKm).toBeGreaterThan(1.45e8);
    expect(sun.refRangeKm).toBeLessThan(1.55e8);
    expect(sun.refSpeedKmS).toBeGreaterThan(25); // the Earth's 29.8 km/s dominates
    expect(sun.refSpeedKmS).toBeLessThan(40);
  });
});

describe('reference bodies on the distance scale', () => {
  const dirOf = (v: Vec3): Vec3 => [v[0] / norm(v), v[1] / norm(v), v[2] / norm(v)];

  it('draws the Moon at its true place in both scales (it is inside the shell threshold)', () => {
    for (const scale of ['compressed', 'true'] as const) {
      const d = refDisplay('MOON', NOW, scale);
      expect(d.k).toBe(1);
      expect(d.r).toEqual(moonPositionEci(NOW));
    }
  });

  it('puts the Sun on the shell in the same direction, shrunk to keep its angular size', () => {
    const real = refPositionEci('SUN', NOW);
    const d = refDisplay('SUN', NOW, 'compressed');
    expect(norm(d.r)).toBeCloseTo(shellRadius(norm(real)), 3);
    expect(norm(d.r)).toBeGreaterThan(SHELL_THRESHOLD_KM);
    expect(norm(d.r)).toBeLessThan(4e6);
    dirOf(d.r).forEach((x, i) => expect(x).toBeCloseTo(dirOf(real)[i], 12));
    // radius / distance is unchanged, so the Sun still spans ~0.53 degrees from the Earth
    expect((REF_RADIUS_KM.SUN * d.k) / norm(d.r)).toBeCloseTo(REF_RADIUS_KM.SUN / norm(real), 12);
    // and its displayed disc still lies beyond the Moon and well outside the Earth
    expect(norm(d.r) - REF_RADIUS_KM.SUN * d.k).toBeGreaterThan(SHELL_THRESHOLD_KM);
  });

  it('leaves the Sun real in the true scale and the Earth at the origin in both', () => {
    const t = refDisplay('SUN', NOW, 'true');
    expect(t.k).toBe(1);
    expect(t.r).toEqual(refPositionEci('SUN', NOW));
    for (const scale of ['compressed', 'true'] as const) {
      expect(refDisplay('EARTH', NOW, scale)).toEqual({ r: [0, 0, 0], k: 1 });
    }
  });

  it('frames and bounds the camera against the displayed radius, not the true one', () => {
    const { k } = refDisplay('SUN', NOW, 'compressed');
    expect(k).toBeLessThan(0.05);
    expect(refViewDistKm('SUN', k)).toBeCloseTo(REF_RADIUS_KM.SUN * k * 4, 6);
    expect(refViewDistKm('SUN', k)).toBeGreaterThan(refMinDistKm('SUN', k));
    expect(refMinDistKm('SUN', k)).toBeCloseTo(REF_RADIUS_KM.SUN * k * 1.02, 6);
    // default k keeps the true-scale framing
    expect(refViewDistKm('SUN')).toBe(REF_RADIUS_KM.SUN * 4);
  });
});
