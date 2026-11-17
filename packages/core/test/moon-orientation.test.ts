import { describe, expect, it } from 'vitest';
import { DEG, MOON, MOON_PERIODIC, convert, iauAngles, inertialToFixedMatrix, mulMV } from '../src';
import { MOON_SUB_EARTH } from './fixtures/horizons-moon-subearth';

const fx = MOON_SUB_EARTH;
const MON: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const ms = (s: string): number => {
  const m = /^(\d{4})-(\w{3})-(\d\d) (\d\d):(\d\d)$/.exec(s)!;
  return Date.UTC(+m[1], MON[m[2]], +m[3], +m[4], +m[5]);
};
const wrap180 = (x: number): number => ((((x + 180) % 360) + 360) % 360) - 180;

/** where the Earth is on the Moon's own sphere (the sub-Earth point), from the registry rotation */
function subEarth(t: number): { lon: number; lat: number } {
  const r = convert({ frame: 'EARTH:inertial', r: [0, 0, 0] }, 'MOON:fixed', t).r;
  return { lon: Math.atan2(r[1], r[0]) / DEG, lat: Math.asin(r[2] / Math.hypot(r[0], r[1], r[2])) / DEG };
}

describe('the Moon orientation: the IAU series (pck00011 E1..E13) against JPL Horizons', () => {
  it('has the 13 arguments and 13 terms of each series from pck00011', () => {
    expect(MOON_PERIODIC.angles).toHaveLength(13);
    for (const k of ['ra', 'dec', 'pm'] as const) expect(MOON_PERIODIC[k]).toHaveLength(13);
    expect(MOON_PERIODIC.angles[0]).toEqual([125.045, -1935.5364525]);
    expect(MOON_PERIODIC.pm[0]).toBe(3.561);
  });

  it('the periodic terms move W by up to ~3.6 deg and the pole by ~1.5 deg: a linear model is that far off', () => {
    let maxW = 0;
    for (let k = 0; k < 400; k++) {
      const t = Date.UTC(2026, 0, 1) + k * 3 * 86_400_000;
      const lin = { ...MOON.rotation, periodic: undefined } as typeof MOON.rotation & { kind: 'linear' };
      const a = iauAngles(MOON.rotation as never, t), b = iauAngles(lin as never, t);
      maxW = Math.max(maxW, Math.abs(wrap180(a.wDeg - b.wDeg)));
    }
    expect(maxW).toBeGreaterThan(3);
    expect(maxW).toBeLessThan(4.5);
  });

  it('the sub-Earth point agrees with Horizons (MOON_ME frame, 22 dates in 2026 and 2035): mean under 0.1 deg, worst under 0.35 deg (the rest is the registry Moon ephemeris)', () => {
    expect(fx.rows).toHaveLength(22);
    let worst = 0, sum = 0;
    for (const [d, lon, lat] of fx.rows) {
      const s = subEarth(ms(d));
      const e = Math.max(Math.abs(wrap180(s.lon - +lon)), Math.abs(s.lat - +lat));
      worst = Math.max(worst, e);
      sum += e;
    }
    expect(sum / fx.rows.length).toBeLessThan(0.1);
    expect(worst).toBeLessThan(0.35);
  });

  it('the same check with the linear model only (no E1..E13 terms) misses the sub-Earth latitude by up to 1.6 deg: the pole terms are what make it agree', () => {
    const linear = { ...MOON, rotation: { ...(MOON.rotation as object), periodic: undefined } } as typeof MOON;
    let worst = 0;
    for (const [d, , lat] of fx.rows) {
      const t = ms(d);
      const inert = convert({ frame: 'EARTH:inertial', r: [0, 0, 0] }, 'MOON:inertial', t).r;
      const r = mulMV(inertialToFixedMatrix(linear, t), inert);
      worst = Math.max(worst, Math.abs(Math.asin(r[2] / Math.hypot(r[0], r[1], r[2])) / DEG - +lat));
    }
    expect(worst).toBeGreaterThan(1.2);
  });
});
