import { describe, expect, it } from 'vitest';
import {
  AUTO_SURFACE_MAX_ALT_KM, SURFACE_PREF_KEY, loadSurfacePref, saveSurfacePref, shouldAutoSurface,
} from '../src/lib/surface';

const ON = { pref: true, earthCentred: true };
const earth = { bodyId: 'EARTH' };

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

  it('is off for objects whose primary body is not the Earth', () => {
    expect(shouldAutoSurface({ bodyId: 'MOON' }, 50, ON)).toBe(false);
    expect(shouldAutoSurface({ bodyId: 'MARS' }, 400, ON)).toBe(false);
  });

  it('is off while the frame is not the Earth (Moon and Sun views)', () => {
    expect(shouldAutoSurface(earth, 420, { pref: true, earthCentred: false })).toBe(false);
    expect(shouldAutoSurface(null, 0, { pref: true, earthCentred: false })).toBe(false);
  });

  it('is off after the user switched the surface view off', () => {
    expect(shouldAutoSurface(earth, 420, { pref: false, earthCentred: true })).toBe(false);
    expect(shouldAutoSurface(null, 0, { pref: false, earthCentred: true })).toBe(false);
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
