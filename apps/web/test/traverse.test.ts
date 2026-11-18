import { describe, expect, it } from 'vitest';
import { convert, defaultBodies, geodeticToFixed, surfaceShape, type FrameId } from '@eio/core';
import { CLOSE_UP_DIST_KM, CLOSE_UP_ELEVATION, TRAVERSE_LIFT_KM, bodyAxes, closeUpDirection, closeUpDistance, localAngles, localOffsetDir, reachFrom, siteBasis, traverseFixed, traverseRetryMs, traverseWorld } from '../src/lib/traverse';

const T = Date.UTC(2026, 10, 17, 12);
const M20: [number, number, number][] = [[18.444627, 77.450886, 13], [18.43559, 77.287, 2009], [18.435594, 77.233223, 2022]];
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: number[]) => Math.hypot(a[0], a[1], a[2]);

describe('traverse points on the body', () => {
  it('lie on the sphere of the registry radius plus the lift, on the planetocentric latitude and east longitude (the shape the sites use)', () => {
    const out = new Float64Array(9);
    expect(traverseFixed(M20, 'MARS', out)).toBe(3);
    const mars = surfaceShape(defaultBodies.get('MARS'));
    for (let i = 0; i < 3; i++) expect(len([out[i * 3], out[i * 3 + 1], out[i * 3 + 2]])).toBeCloseTo(mars.radiusKm + TRAVERSE_LIFT_KM, 6);
    const site = geodeticToFixed({ lat: (M20[0][0] * Math.PI) / 180, lon: (M20[0][1] * Math.PI) / 180, alt: TRAVERSE_LIFT_KM }, mars);
    expect(out[0]).toBeCloseTo(site[0], 6);
    expect(out[1]).toBeCloseTo(site[1], 6);
    expect(out[2]).toBeCloseTo(site[2], 6);
  });

  it('keeps at most what the buffer holds', () => {
    expect(traverseFixed(M20, 'MARS', new Float64Array(6))).toBe(2);
  });
});

describe('Mars-fixed to Earth-inertial by four conversions', () => {
  it('the axes are orthonormal and the origin is where Mars is (1e8 km from the Earth)', () => {
    const a = bodyAxes('MARS', T)!;
    expect(len(a.ex)).toBeCloseTo(1, 9);
    expect(len(a.ey)).toBeCloseTo(1, 9);
    expect(len(a.ez)).toBeCloseTo(1, 9);
    expect(dot(a.ex, a.ey)).toBeCloseTo(0, 9);
    expect(dot(a.ex, a.ez)).toBeCloseTo(0, 9);
    expect(len(a.o)).toBeGreaterThan(5e7);
  });

  it('places every point where the entity graph converts it (the rover marker uses that), to the metre, at any time', () => {
    const fixed = new Float64Array(9);
    traverseFixed(M20, 'MARS', fixed);
    for (const t of [T, T + 5 * 3600_000, T + 400 * 3600_000]) {
      const world = new Float64Array(9);
      traverseWorld(fixed, 3, bodyAxes('MARS', t)!, world);
      for (let i = 0; i < 3; i++) {
        const want = convert({ frame: 'MARS:fixed' as FrameId, r: [fixed[i * 3], fixed[i * 3 + 1], fixed[i * 3 + 2]] }, 'EARTH:inertial' as FrameId, t).r;
        expect(Math.hypot(world[i * 3] - want[0], world[i * 3 + 1] - want[1], world[i * 3 + 2] - want[2])).toBeLessThan(1e-3);
      }
    }
  });

  it('turns with the planet: a point moves about 0.24 km a second in the inertial frame', () => {
    const fixed = new Float64Array(3);
    traverseFixed([[0, 0, 0]], 'MARS', fixed);
    const a = new Float64Array(3), b = new Float64Array(3);
    traverseWorld(fixed, 1, bodyAxes('MARS', T)!, a);
    traverseWorld(fixed, 1, bodyAxes('MARS', T + 1000)!, b);
    const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    expect(d).toBeGreaterThan(0.2);
    expect(d).toBeLessThan(40); // plus Mars's own motion round the Sun (about 24 km/s)
  });

  it('reachFrom: the farthest point from the rover, km', () => {
    const fixed = new Float64Array(9);
    traverseFixed(M20, 'MARS', fixed);
    const last = [fixed[6], fixed[7], fixed[8]];
    const reach = reachFrom(fixed, 3, last);
    // 77.4509 - 77.2332 deg of longitude at 18.44 N on a 3396 km sphere: about 12.6 km
    expect(reach).toBeGreaterThan(12);
    expect(reach).toBeLessThan(13.5);
  });
});

describe('Close-up of a surface object', () => {
  const up: [number, number, number] = [0, 0, 1];

  it('looks from 45 degrees over the horizon, on the side of the Sun', () => {
    const d = closeUpDirection(up, [1, 0, 0.3]);
    expect(len(d)).toBeCloseTo(1, 12);
    expect(Math.asin(dot(d, up))).toBeCloseTo(CLOSE_UP_ELEVATION, 12);
    expect(d[0]).toBeGreaterThan(0);
    expect(d[1]).toBeCloseTo(0, 12);
  });

  it('a Sun below the horizon still gives the horizontal side it is on; a Sun on the vertical gives a defined, horizontal-tilted direction', () => {
    const night = closeUpDirection(up, [0, -1, -0.5]);
    expect(night[1]).toBeLessThan(0);
    expect(night[2]).toBeGreaterThan(0);
    const noon = closeUpDirection([1, 0, 0], [1, 0, 0]);
    expect(len(noon)).toBeCloseTo(1, 12);
    expect(Math.asin(noon[0])).toBeCloseTo(CLOSE_UP_ELEVATION, 12);
    const pole = closeUpDirection(up, up);
    expect(Math.asin(pole[2])).toBeCloseTo(CLOSE_UP_ELEVATION, 12);
  });

  it('a lone object is viewed from a few km; a traverse widens it to fit the whole path', () => {
    expect(closeUpDistance(0, 45, 1.6, 1.3)).toBe(CLOSE_UP_DIST_KM);
    expect(closeUpDistance(0.5, 45, 1.6, 1.3)).toBe(CLOSE_UP_DIST_KM);
    const wide = closeUpDistance(12.6, 45, 1.6, 1.3);
    expect(wide).toBeGreaterThan(20);
    expect(wide).toBeLessThan(80);
  });
});

describe('the Close-up offset lives in the site frame, so it turns with the planet', () => {
  const lat = 18.44, lon = 77.45;
  const upAt = (t: number): number[] => {
    const s = convert({ frame: 'MARS:fixed' as FrameId, r: [0, 0, 0] }, 'EARTH:inertial' as FrameId, t).r;
    const fixed = new Float64Array(3);
    traverseFixed([[lat, lon]], 'MARS', fixed, 0);
    const p = convert({ frame: 'MARS:fixed' as FrameId, r: [fixed[0], fixed[1], fixed[2]] }, 'EARTH:inertial' as FrameId, t).r;
    const d = [p[0] - s[0], p[1] - s[1], p[2] - s[2]];
    const l = len(d);
    return d.map((v) => v / l);
  };

  it('siteBasis is orthonormal and its up is the true local vertical at any time', () => {
    for (const h of [0, 1, 3, 6, 12]) {
      const t = T + h * 3600_000;
      const b = siteBasis('MARS', lat, lon, t)!;
      expect(dot(b.e, b.n)).toBeCloseTo(0, 8);
      expect(dot(b.e, b.u)).toBeCloseTo(0, 8);
      const up = upAt(t);
      expect(dot(b.u, up)).toBeCloseTo(1, 7);
    }
  });

  it('a camera at 45 degrees stays at 45 degrees over the local horizon for hours, while the same world direction would sink below it', () => {
    const b0 = siteBasis('MARS', lat, lon, T)!;
    const world = localOffsetDir(b0, 0.7, CLOSE_UP_ELEVATION); // what a fixed inertial offset would keep
    let drift = 0;
    for (const h of [1, 3, 6, 9]) {
      const t = T + h * 3600_000;
      const up = upAt(t);
      const local = localOffsetDir(siteBasis('MARS', lat, lon, t)!, 0.7, CLOSE_UP_ELEVATION);
      expect(Math.asin(dot(local, up))).toBeCloseTo(CLOSE_UP_ELEVATION, 6);
      drift = Math.max(drift, Math.abs(Math.asin(dot(world, up)) - CLOSE_UP_ELEVATION));
    }
    expect(drift).toBeGreaterThan(0.3); // a fixed inertial offset would have left the 45 degrees by tens of degrees
  });

  it('localAngles inverts localOffsetDir', () => {
    const b = siteBasis('MARS', lat, lon, T)!;
    const a = localAngles(localOffsetDir(b, -2.1, 0.5), b);
    expect(a.az).toBeCloseTo(-2.1, 8);
    expect(a.el).toBeCloseTo(0.5, 8);
  });
});

describe('traverse retry schedule', () => {
  it('5 s, 15 s, 60 s, then every 5 min', () => {
    expect([0, 1, 2, 3, 4, 50].map(traverseRetryMs)).toEqual([5000, 15000, 60000, 300000, 300000, 300000]);
  });
});
