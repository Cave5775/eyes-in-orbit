import { describe, expect, it } from 'vitest';
import { DEG, EARTH, elementsFromState, keplerState, type KeplerElements, type Vec3 } from '../src';

const T0 = Date.UTC(2026, 9, 22, 12);
const el = (over: Partial<KeplerElements>): KeplerElements => ({ a: 6900, e: 0.01, i: 51.6 * DEG, raan: 40 * DEG, argp: 70 * DEG, m0: 100 * DEG, epochMs: T0, ...over });
const close = (a: Vec3, b: Vec3, tol: number) => { for (let k = 0; k < 3; k++) expect(a[k]).toBeCloseTo(b[k], tol); };

describe('elementsFromState', () => {
  it('inverts keplerState for a generic orbit (elements and state)', () => {
    const src = el({});
    for (const dt of [0, 600_000, 5_000_000]) {
      const s = keplerState(src, EARTH.gm, T0 + dt);
      const back = elementsFromState(s.r, s.v, EARTH.gm, T0 + dt);
      expect(back.a).toBeCloseTo(src.a, 6);
      expect(back.e).toBeCloseTo(src.e, 9);
      expect(back.i).toBeCloseTo(src.i, 9);
      expect(back.raan).toBeCloseTo(src.raan, 9);
      expect(back.argp).toBeCloseTo(src.argp, 7);
      expect(back.epochMs).toBe(T0 + dt);
      // the same orbit: propagating the recovered elements from their own epoch matches the original later on
      const later = T0 + dt + 3_000_000;
      const x = keplerState(src, EARTH.gm, later), y = keplerState(back, EARTH.gm, later);
      close(x.r, y.r, 5);
      close(x.v, y.v, 8);
    }
  });

  it('reproduces the state for retrograde, polar, equatorial and circular orbits', () => {
    const cases: [string, Partial<KeplerElements>][] = [
      ['sun-synchronous', { i: 97.4 * DEG, e: 0.001 }],
      ['polar', { i: 90 * DEG }],
      ['near-circular inclined', { e: 1e-11, a: 6778 }],
      ['circular inclined', { e: 0, a: 6778 }],
      ['equatorial eccentric', { i: 0, raan: 0, e: 0.2, a: 24000 }],
      ['retrograde equatorial', { i: 180 * DEG, raan: 0, e: 0.1, a: 8000 }],
      ['circular equatorial (GEO)', { i: 0, raan: 0, e: 0, a: 42164 }],
      ['near-equatorial', { i: 1e-9, e: 0.05, a: 7000 }],
      ['Molniya-like', { a: 26560, e: 0.74, i: 63.4 * DEG, argp: 270 * DEG }],
    ];
    for (const [name, over] of cases) {
      const src = el(over);
      for (const dt of [0, 1_234_000]) {
        const s = keplerState(src, EARTH.gm, T0 + dt);
        const back = elementsFromState(s.r, s.v, EARTH.gm, T0 + dt);
        const probe = keplerState(back, EARTH.gm, T0 + dt);
        close(probe.r, s.r, 5);
        close(probe.v, s.v, 8);
        // and onwards in time
        const later = T0 + dt + 2_000_000;
        const x = keplerState(src, EARTH.gm, later), y = keplerState(back, EARTH.gm, later);
        for (let k = 0; k < 3; k++) expect(Math.abs(x.r[k] - y.r[k]), `${name} +${dt}`).toBeLessThan(1e-3);
      }
    }
  });

  it('uses the argument-of-latitude convention for circular orbits and 0 for the missing node', () => {
    const s = keplerState(el({ e: 0, a: 6778 }), EARTH.gm, T0);
    const back = elementsFromState(s.r, s.v, EARTH.gm, T0);
    expect(back.e).toBeLessThan(1e-9);
    expect(back.argp).toBe(0);
    expect(back.raan).toBeCloseTo(40 * DEG, 9);
    const eq = keplerState(el({ i: 0, raan: 0, e: 0, a: 42164, argp: 0, m0: 1 }), EARTH.gm, T0);
    const eqBack = elementsFromState(eq.r, eq.v, EARTH.gm, T0);
    expect(eqBack.raan).toBe(0);
    expect(eqBack.m0).toBeCloseTo(1, 9);
  });

  it('rejects unbound and degenerate states', () => {
    expect(() => elementsFromState([7000, 0, 0], [0, 12, 0], EARTH.gm, T0)).toThrow(RangeError);
    expect(() => elementsFromState([0, 0, 0], [0, 7, 0], EARTH.gm, T0)).toThrow(RangeError);
    expect(() => elementsFromState([7000, 0, 0], [7, 0, 0], EARTH.gm, T0)).toThrow(RangeError);
  });
});
