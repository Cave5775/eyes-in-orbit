import { describe, expect, it } from 'vitest';
import {
  DEG, EARTH, destinationPoint, downrangeStepKm, fixedToGeodetic, profileToFixedSamples, reconstructDownrange,
} from '../src';

describe('ascent reconstruction', () => {
  it('downrange step ignores vertical speed component', () => {
    expect(downrangeStepKm(5, 3, 2)).toBeCloseTo(8, 9); // sqrt(25-9)=4 km/s * 2 s
    expect(downrangeStepKm(1, 2, 1)).toBe(0);
  });

  it('integrates telemetry rows into downrange', () => {
    const out = reconstructDownrange([
      { tSec: 0, altKm: 0, speedKmS: 0 },
      { tSec: 10, altKm: 1, speedKmS: 0.2 },
      { tSec: 20, altKm: 4, speedKmS: 0.5 },
    ]);
    expect(out[0].downrangeKm).toBe(0);
    expect(out[2].downrangeKm).toBeGreaterThan(out[1].downrangeKm);
  });

  it('destination point goes east along the equator by the expected arc', () => {
    const p = destinationPoint(0, 0, 90, (Math.PI / 2) * EARTH.radiusKm, EARTH.radiusKm);
    expect(p.latDeg).toBeCloseTo(0, 6);
    expect(p.lonDeg).toBeCloseTo(90, 6);
  });

  it('profile samples start at the pad and gain altitude', () => {
    const pad = { latDeg: 28.5, lonDeg: -80.6 };
    const samples = profileToFixedSamples(EARTH, pad, 90, 1_000_000, [
      { tSec: 0, altKm: 0, downrangeKm: 0 },
      { tSec: 60, altKm: 12, downrangeKm: 8 },
    ]);
    expect(samples[0][0]).toBe(1_000_000);
    expect(samples[1][0]).toBe(1_060_000);
    const g = fixedToGeodetic([samples[1][1], samples[1][2], samples[1][3]], EARTH);
    expect(g.alt).toBeCloseTo(12, 3);
    expect(g.lon / DEG).toBeGreaterThan(-80.6);
  });
});
