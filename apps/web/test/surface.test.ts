import { describe, expect, it } from 'vitest';
import {
  AUTO_SURFACE_MAX_ALT_KM, AUTO_SURFACE_MAX_RADII, SURFACE_PREF_KEY, loadSurfacePref, saveSurfacePref, shouldAutoSurface, surfaceBodyFor,
} from '../src/lib/surface';

const ON = { pref: true, bodyId: 'EARTH' as string | null };
const MOON_ON = { pref: true, bodyId: 'MOON' as string | null };
const MARS_ON = { pref: true, bodyId: 'MARS' as string | null };
const earth = {};
const bodyRec = { provider: { type: 'body' as const, bodyId: 'MOON' } };

describe('auto surface policy', () => {
  it('is on for objects near the Earth: orbit, ascent, booster, ground', () => {
    expect(shouldAutoSurface(earth, 420, ON)).toBe(true); // ISS
    expect(shouldAutoSurface(earth, 35_786, ON)).toBe(true); // GEO
    expect(shouldAutoSurface(earth, 120, ON)).toBe(true); // launch vehicle in ascent
    expect(shouldAutoSurface(earth, 35, ON)).toBe(true); // booster on its landing burn
    expect(shouldAutoSurface(earth, 0, ON)).toBe(true); // pad or landed booster
    expect(shouldAutoSurface(earth, -0.02, ON)).toBe(true); // ground entity a hair under the ellipsoid
  });

  it('is on for a bare ground point (a pad focused by latitude and longitude)', () => {
    expect(shouldAutoSurface(null, 0, ON)).toBe(true);
    expect(shouldAutoSurface(null, null, ON)).toBe(true);
  });

  it('is off for deep space and for entities with no position', () => {
    expect(shouldAutoSurface(earth, AUTO_SURFACE_MAX_ALT_KM, ON)).toBe(false);
    expect(shouldAutoSurface(earth, AUTO_SURFACE_MAX_ALT_KM - 1, ON)).toBe(true);
    expect(shouldAutoSurface(earth, 384_400, ON)).toBe(false); // out at the Moon
    expect(shouldAutoSurface(earth, 2e6, ON)).toBe(false); // the deep-space shell
    expect(shouldAutoSurface(earth, 1e10, ON)).toBe(false); // a probe
    expect(shouldAutoSurface(earth, null, ON)).toBe(false);
    expect(shouldAutoSurface(earth, Number.NaN, ON)).toBe(false);
  });

  it('is on for objects near the Moon and Mars (orbiters, landers, rovers), by the body radius', () => {
    expect(shouldAutoSurface(earth, 50, MOON_ON)).toBe(true); // LRO
    expect(shouldAutoSurface(earth, 0, MOON_ON)).toBe(true); // Apollo 11 on the ground
    expect(shouldAutoSurface(earth, 400, MARS_ON)).toBe(true); // MRO
    expect(shouldAutoSurface(earth, 0, MARS_ON)).toBe(true); // Perseverance
    expect(shouldAutoSurface(earth, 6_000, MARS_ON)).toBe(true); // MAVEN at apoapsis
    expect(shouldAutoSurface(earth, 1e6, MARS_ON)).toBe(false);
    expect(AUTO_SURFACE_MAX_RADII * 1737.4).toBeCloseTo(27_240, -1); // the same 15.7 radii at the Moon
    expect(shouldAutoSurface(earth, AUTO_SURFACE_MAX_RADII * 1737.4 + 1, MOON_ON)).toBe(false);
  });

  it('is off for a body entity itself (a body is viewed from outside)', () => {
    expect(shouldAutoSurface(bodyRec, 0, MOON_ON)).toBe(false);
  });

  it('is off with no ground body (a deep-space probe, the Sun)', () => {
    expect(shouldAutoSurface(earth, 420, { pref: true, bodyId: null })).toBe(false);
    expect(shouldAutoSurface(null, 0, { pref: true, bodyId: null })).toBe(false);
  });

  it('is off after the user switched the surface view off', () => {
    expect(shouldAutoSurface(earth, 420, { pref: false, bodyId: 'EARTH' })).toBe(false);
    expect(shouldAutoSurface(null, 0, { pref: false, bodyId: 'EARTH' })).toBe(false);
    expect(shouldAutoSurface(earth, 50, { pref: false, bodyId: 'MOON' })).toBe(false);
  });
});

describe('surfaceBodyFor: the primary body of the subject', () => {
  it('a satellite, station, capsule, pad or booster is on the Earth, whatever the frame', () => {
    expect(surfaceBodyFor({ kind: 'satellite', bodyId: 'EARTH' }, null)).toBe('EARTH');
    expect(surfaceBodyFor({ kind: 'station', bodyId: 'EARTH' }, 'MOON')).toBe('EARTH');
    expect(surfaceBodyFor({ kind: 'launch', bodyId: 'EARTH' }, 'MARS')).toBe('EARTH');
  });

  it('an orbiter of another body is on that body; a lander or rover on the body it stands on', () => {
    const geo = (bodyId: string) => ({ type: 'geodetic' as const, bodyId, latDeg: 0, lonDeg: 0, altKm: 0 });
    expect(surfaceBodyFor({ kind: 'rover', bodyId: 'MARS', provider: geo('MARS') }, null)).toBe('MARS');
    expect(surfaceBodyFor({ kind: 'lander', bodyId: 'MOON', provider: geo('MOON') }, 'EARTH')).toBe('MOON');
    expect(surfaceBodyFor({ kind: 'lander', bodyId: 'TITAN', provider: geo('TITAN') }, null)).toBe('TITAN');
  });

  it('a body entity is its own ground; the Sun has none; a heliocentric probe has none', () => {
    expect(surfaceBodyFor({ kind: 'planet', bodyId: 'MARS', provider: { type: 'body', bodyId: 'MARS' } }, null)).toBe('MARS');
    expect(surfaceBodyFor({ kind: 'dwarf_planet', bodyId: 'CERES', provider: { type: 'body', bodyId: 'CERES' } }, null)).toBe('CERES');
    expect(surfaceBodyFor({ kind: 'star', bodyId: 'SUN', provider: { type: 'body', bodyId: 'SUN' } }, null)).toBeNull();
    expect(surfaceBodyFor({ kind: 'probe', bodyId: 'SUN' }, null, 1e9)).toBeNull();
  });

  it('with no subject the frame centre decides: a body with a ground, else the Earth; the Sun frame has none', () => {
    expect(surfaceBodyFor(null, null)).toBe('EARTH');
    expect(surfaceBodyFor(null, 'EARTH')).toBe('EARTH');
    expect(surfaceBodyFor(null, 'MOON')).toBe('MOON');
    expect(surfaceBodyFor(null, 'SUN')).toBeNull();
  });
});

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('remembered surface choice', () => {
  it('defaults to on', () => {
    expect(loadSurfacePref(fakeStorage())).toBe(true);
    expect(loadSurfacePref(null)).toBe(true);
  });

  it('remembers off, and on restores the default', () => {
    const s = fakeStorage();
    saveSurfacePref(false, s);
    expect(s.data.get(SURFACE_PREF_KEY)).toBe('off');
    expect(loadSurfacePref(s)).toBe(false);
    saveSurfacePref(true, s);
    expect(s.data.has(SURFACE_PREF_KEY)).toBe(false);
    expect(loadSurfacePref(s)).toBe(true);
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(loadSurfacePref(broken)).toBe(true);
    expect(() => saveSurfacePref(false, broken)).not.toThrow();
    expect(() => saveSurfacePref(true, broken)).not.toThrow();
  });

  it('ignores unknown stored values', () => {
    expect(loadSurfacePref(fakeStorage({ [SURFACE_PREF_KEY]: 'banana' }))).toBe(true);
  });
});
