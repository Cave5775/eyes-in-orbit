import { describe, expect, it } from 'vitest';
import { EARTH, MARS, MOON, SUN, bodyStateEci, defaultBodies, listParent, soiKm, sunDirectionEci, type Sample, type SampleWindow } from '../src';

const T0 = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;

describe('soiKm (Laplace sphere of influence)', () => {
  it('Earth is about 925,000 km and Mars about 577,000 km', () => {
    expect(soiKm(EARTH)!).toBeGreaterThan(900_000);
    expect(soiKm(EARTH)!).toBeLessThan(950_000);
    expect(soiKm(MARS)!).toBeGreaterThan(560_000);
    expect(soiKm(MARS)!).toBeLessThan(595_000);
  });
  it('the Moon is about 66,000 km; the Sun has none', () => {
    expect(soiKm(MOON)!).toBeGreaterThan(60_000);
    expect(soiKm(MOON)!).toBeLessThan(72_000);
    expect(soiKm(SUN)).toBeUndefined();
  });
});

describe('listParent', () => {
  const rec = { bodyId: 'EARTH' };
  const track = (frame: SampleWindow['frame'], at: (t: number) => number[], days = 3): SampleWindow => {
    const samples: Sample[] = [];
    for (let k = 0; k <= days * 4; k++) { const t = T0 + (k * DAY) / 4; samples.push([t, ...at(t)]); }
    return { frame, samples };
  };

  it('JWST at L2 (1.5e6 km from the Earth) is under the Sun', () => {
    const w = track('EARTH:inertial', (t) => sunDirectionEci(t).map((c) => -c * 1.5e6));
    expect(listParent(rec, w)).toBe('SUN');
  });
  it('a Moon orbiter is under the Moon, a Mars orbiter under Mars', () => {
    expect(listParent({ bodyId: 'MOON' }, track('MOON:inertial', () => [1837, 0, 0]))).toBe('MOON');
    expect(listParent({ bodyId: 'MARS' }, track('MARS:inertial', () => [3800, 0, 0]))).toBe('MARS');
  });
  it('a low Earth orbit stays under the Earth', () => {
    expect(listParent(rec, track('EARTH:inertial', () => [7000, 0, 0]))).toBe('EARTH');
  });
  it('a transfer window from the Earth to Mars is under the Sun', () => {
    const w = track('EARTH:inertial', (t) => {
      const f = (t - T0) / (3 * DAY);
      const m = bodyStateEci('MARS', t).r;
      return [7000 * (1 - f) + m[0] * f, m[1] * f, m[2] * f];
    });
    expect(listParent(rec, w)).toBe('SUN');
  });
  it('samples in the Earth and then the Moon sphere list under the Earth', () => {
    const w = track('EARTH:inertial', (t) => (t < T0 + 1.5 * DAY ? [7000, 0, 0] : [...bodyStateEci('MOON', t).r]));
    expect(listParent(rec, w)).toBe('EARTH');
  });
  it('no samples or an unknown frame falls back to bodyId', () => {
    expect(listParent(rec, undefined)).toBe('EARTH');
    expect(listParent(rec, { frame: 'EARTH:inertial', samples: [] })).toBe('EARTH');
    expect(listParent(rec, { frame: 'NOWHERE:inertial', samples: [[T0, 1, 2, 3]] })).toBe('EARTH');
    expect(defaultBodies.has('EARTH')).toBe(true);
  });
});
