import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BodyRegistry, SampledProvider, bodyStateEci, convert, precessDir, setBodyStream, streamToFrameAxes, type Sample, type Vec3 } from '@eio/core';
import { parseHorizonsVectors } from '../../../src/engine/connectors/horizons';

// Real Horizons vectors (ICRF, km, km/s; trimmed, fetched 2026-11-17): Juno (-61) geocentric, Sun-centred and Jupiter-centred,
// 2026-11-10 .. 11-20 daily, and LRO (-85) Moon-centred, 2026-11-16 00:00..04:00 every 10 min.
const fx = (n: string): Sample[] => parseHorizonsVectors(readFileSync(new URL(`../../fixtures/${n}`, import.meta.url), 'utf8'));
const dist = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const geo = fx('horizons-juno-geocentric.json');
const hel = fx('horizons-juno-heliocentric.json');
const jupCentred = fx('horizons-juno-jupiter-centred.json');
const t = geo[6][0]; // 2026-11-16
const reg = new BodyRegistry();
setBodyStream('JUPITER', { frame: 'SUN:inertial', samples: parseHorizonsVectors(readFileSync(new URL('../../fixtures/horizons-body-jupiter.json', import.meta.url), 'utf8')) }, reg);
const jupiter = bodyStateEci('JUPITER', t, reg).r;
const truth = Math.hypot(...(jupCentred[6].slice(1, 4) as Vec3)); // Juno to Jupiter from Horizons itself

const drawn = (samples: Sample[], frame: 'EARTH:inertial' | 'SUN:inertial') =>
  convert(new SampledProvider(frame, samples).stateAt(t)!, 'EARTH:inertial', t, reg);

describe('Horizons streams in a frame of date (streamToFrameAxes)', () => {
  it('BEFORE the fix (raw ICRF samples in EARTH:inertial) Juno was 6.1e6 km from Jupiter, 5.2e6 km off the Sun-centred track', () => {
    const raw = drawn(geo, 'EARTH:inertial').r;
    expect(dist(raw, jupiter)).toBeGreaterThan(5.5e6);
    expect(dist(raw, drawn(hel, 'SUN:inertial').r)).toBeGreaterThan(4.5e6);
  });

  it('Juno tracked Earth-centred sits at its true distance from the drawn Jupiter (3.2e6 km, its orbit), not 6e6', () => {
    const r = drawn(streamToFrameAxes('EARTH:inertial', geo), 'EARTH:inertial').r;
    expect(truth).toBeGreaterThan(2.5e6);
    // what is left is the accuracy of the Sun series the hop puts the planet against (about 0.01 deg of 1 AU, 2.6e4 km)
    expect(Math.abs(dist(r, jupiter) - truth)).toBeLessThan(1e5);
    expect(dist(r, jupiter)).toBeLessThan(8e6);
  });

  it('the same probe tracked Earth-centred and Sun-centred lands on the same point (the Sun-series accuracy, not 5e6 km)', () => {
    const a = drawn(streamToFrameAxes('EARTH:inertial', geo), 'EARTH:inertial');
    const b = drawn(hel, 'SUN:inertial');
    expect(dist(a.r, b.r)).toBeLessThan(5e4);
    expect(dist(a.v!, b.v!)).toBeLessThan(0.03); // km/s: the Sun series' central-difference velocity vs the true Earth's; unrotated it was ~0.1
  });

  it('LRO (Moon-centred): the 11 km tilt is a rotation of the orbit by the precession, removed round the Moon, radius kept', () => {
    const lro = fx('horizons-lro-moon-centred.json');
    const out = streamToFrameAxes('MOON:inertial', lro);
    expect(out).toHaveLength(lro.length);
    let worst = 0;
    for (let i = 0; i < lro.length; i++) {
      const rr = Math.hypot(lro[i][1], lro[i][2], lro[i][3]);
      expect(Math.hypot(out[i][1], out[i][2], out[i][3])).toBeCloseTo(rr, 6);
      expect(Math.hypot(out[i][4], out[i][5], out[i][6])).toBeCloseTo(Math.hypot(lro[i][4], lro[i][5], lro[i][6]), 9);
      worst = Math.max(worst, dist(out[i].slice(1, 4), lro[i].slice(1, 4)));
      const back = precessDir(out[i].slice(1, 4) as Vec3, out[i][0], true);
      expect(dist(back, lro[i].slice(1, 4))).toBeLessThan(1e-6);
    }
    expect(worst).toBeGreaterThan(8);
    expect(worst).toBeLessThan(14); // 0.0066 rad x 1.8e3 km
  });

  it('Hermite interpolation of the rotated samples stays consistent with the rotated velocities (inside a 10 min step, < 0.1 km)', () => {
    const lro = fx('horizons-lro-moon-centred.json');
    const rot = new SampledProvider('MOON:inertial', streamToFrameAxes('MOON:inertial', lro));
    const mid = (lro[3][0] + lro[4][0]) / 2;
    const exact = precessDir(new SampledProvider('MOON:inertial', lro).stateAt(mid)!.r, mid, false);
    expect(dist(rot.stateAt(mid)!.r, exact)).toBeLessThan(0.1);
  });

  it('J2000 frames (a Mars orbiter, the Sun) are returned unchanged, the same array', () => {
    expect(streamToFrameAxes('MARS:inertial', geo)).toBe(geo);
    expect(streamToFrameAxes('SUN:inertial', geo)).toBe(geo);
  });
});
