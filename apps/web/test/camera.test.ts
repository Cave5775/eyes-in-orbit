import { describe, expect, it } from 'vitest';
import { EARTH, enuBasis, geodeticToFixed } from '@eio/core';
import {
  MAX_DIST_KM, MIN_ALT_KM, SMALL_FIT_TILT, altitudeOf, basisFromUp, basisOffset, blendPosition, boundingSphere, elevationAbout, ellipsoidUp, fitAngles, fitDistance, liftToElevation,
  SURFACE_FIT_MAX_KM, SURFACE_FIT_MIN_KM, groundPanDelta, localBasis, minElevation, moveOnSphere, slerpDir, surfaceFitDistance,
  surfaceRadius, viewAnglesFor, zoomDistance, type V3,
} from '../src/lib/camera';

const RE = EARTH.radiusKm;
const dist3 = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe('altitude-scaled zoom', () => {
  const opts = { minDist: RE + MIN_ALT_KM };

  it('changes the altitude multiplicatively when orbiting the Earth centre', () => {
    const alt = 5000;
    const d = zoomDistance(RE + alt, 0.9, alt, opts);
    expect(d - RE).toBeCloseTo(alt * 0.9, 6);
    const out = zoomDistance(RE + alt, 1.1, alt, opts);
    expect(out - RE).toBeCloseTo(alt * 1.1, 6);
  });

  it('takes much finer steps near the surface than far away', () => {
    const near = RE + 20 - zoomDistance(RE + 20, 0.87, 20, opts);
    const far = 3e5 + RE - zoomDistance(3e5 + RE, 0.87, 3e5, opts);
    expect(near).toBeGreaterThan(0);
    expect(near).toBeLessThan(5); // metres-to-km scale
    expect(far).toBeGreaterThan(1e4);
    expect(far / near).toBeGreaterThan(1000);
  });

  it('is fine near a followed object even when it is high above the ground', () => {
    // camera 10 km from a GEO satellite: step follows the 10 km, not the 36,000 km altitude
    const d = zoomDistance(10, 0.5, 35_786, { minDist: 0.2 });
    expect(d).toBeCloseTo(5, 6);
  });

  it('clamps to the near and far limits', () => {
    expect(zoomDistance(RE + 4, 0.1, 4, opts)).toBe(opts.minDist);
    expect(zoomDistance(2.9e7, 50, 2.9e7 - RE, opts)).toBe(MAX_DIST_KM);
    expect(zoomDistance(1, 0.0001, 1, { minDist: 0.2 })).toBeGreaterThanOrEqual(0.2);
  });

  it('minRefFrac keeps a low surface-view camera zoomable', () => {
    const stuck = zoomDistance(1000, 1.2, 20, { minDist: 3 });
    const free = zoomDistance(1000, 1.2, 20, { minDist: 3, minRefFrac: 0.25 });
    expect(stuck - 1000).toBeLessThan(5);
    expect(free - 1000).toBeCloseTo(50, 6);
  });

  it('zoom in then out returns to the start', () => {
    const start = RE + 8000;
    const a = zoomDistance(start, 0.8, 8000, opts);
    const b = zoomDistance(a, 1 / 0.8, a - RE, opts);
    expect(b).toBeCloseTo(start, 6);
  });
});

describe('surface helpers', () => {
  it('altitude agrees with the ellipsoid', () => {
    const p = geodeticToFixed({ lat: 0.6, lon: 1.1, alt: 400 }, EARTH);
    // geocentric radius approximation is within a few km of the true geodetic altitude
    expect(Math.abs(altitudeOf(p as V3) - 400)).toBeLessThan(25);
    expect(surfaceRadius([0, 0, RE])).toBeCloseTo(RE * (1 - EARTH.flattening), 6);
  });

  it('minElevation keeps the camera above the minimum altitude', () => {
    expect(Math.sin(minElevation(100)) * 100).toBeCloseTo(MIN_ALT_KM, 9);
    expect(minElevation(1)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('minElevation lets the camera go below a high target but not into the ground', () => {
    // 400 km up, camera 1,000 km away: it may sit up to 397 km below the target's height
    const el = minElevation(1000, MIN_ALT_KM, 400);
    expect(el).toBeLessThan(0);
    expect(Math.sin(el) * 1000).toBeCloseTo(MIN_ALT_KM - 400, 9);
    // very close to a high target any angle is fine
    expect(minElevation(100, MIN_ALT_KM, 400)).toBeCloseTo(-Math.PI / 2, 9);
    // a target on or below the ground behaves like the ground
    expect(minElevation(100, MIN_ALT_KM, -50)).toBeCloseTo(minElevation(100), 12);
    expect(minElevation(1, MIN_ALT_KM, 0)).toBeCloseTo(Math.PI / 2, 9);
  });
});

describe('fit', () => {
  it('uses the tighter of the vertical and horizontal FOV', () => {
    const wide = fitDistance(100, 45, 2, 1);
    const tall = fitDistance(100, 45, 0.5, 1);
    expect(wide).toBeCloseTo(100 / Math.sin((22.5 * Math.PI) / 180), 6);
    expect(tall).toBeGreaterThan(wide);
    // sphere of radius r at distance d subtends asin(r/d) <= half FOV on both axes
    const d = fitDistance(100, 45, 0.5, 1);
    expect(Math.asin(100 / d)).toBeLessThanOrEqual(Math.atan(Math.tan((22.5 * Math.PI) / 180) * 0.5) + 1e-9);
  });

  it('adds the margin', () => {
    expect(fitDistance(10, 45, 1.5, 1.5) / fitDistance(10, 45, 1.5, 1)).toBeCloseTo(1.5, 9);
    expect(fitDistance(0, 45, 1)).toBe(0);
  });

  it('bounding sphere of two points is their diameter sphere', () => {
    const s = boundingSphere([0, 0, 0, 10, 0, 0]);
    expect(s.r).toBeCloseTo(5, 9);
    expect(s.c).toEqual([5, 0, 0]);
  });

  it('bounding sphere contains every point and is not wildly oversized', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pts: number[] = [];
    for (let i = 0; i < 500; i++) {
      const u = rnd() * 2 - 1, th = rnd() * 6.283, s = Math.sqrt(1 - u * u), r = 50 * Math.cbrt(rnd());
      pts.push(1000 + r * s * Math.cos(th), -300 + r * s * Math.sin(th), 40 + r * u);
    }
    const { c, r } = boundingSphere(pts);
    for (let i = 0; i < 500; i++) expect(dist3(c, [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]])).toBeLessThanOrEqual(r + 1e-6);
    expect(r).toBeLessThan(50 * 1.2);
    expect(boundingSphere([]).r).toBe(0);
    expect(boundingSphere([1, 2, 3]).r).toBe(0);
  });
});

describe('local surface frame', () => {
  it('localBasis matches the core ENU basis', () => {
    for (const [lat, lon] of [[0.5, 1.0], [-0.9, 2.5], [0, 0]]) {
      const a = localBasis(lat, lon), b = enuBasis(lat, lon);
      expect(a.e).toEqual(b.e);
      expect(a.n).toEqual(b.n);
      expect(a.u).toEqual(b.u);
    }
  });

  it('basisFromUp is orthonormal, north points to +Z side and east is eastward', () => {
    const up = ellipsoidUp(geodeticToFixed({ lat: 0.7, lon: -2.0, alt: 0 }, EARTH) as V3);
    const { e, n, u } = basisFromUp(up);
    expect(dot(e, n)).toBeCloseTo(0, 9);
    expect(dot(e, u)).toBeCloseTo(0, 9);
    expect(dot(n, u)).toBeCloseTo(0, 9);
    expect(Math.hypot(...e)).toBeCloseTo(1, 9);
    expect(n[2]).toBeGreaterThan(0);
    const ref = enuBasis(0.7, -2.0);
    // geodetic normal vs enuBasis (geodetic lat): same frame
    expect(dot(e, ref.e)).toBeCloseTo(1, 6);
    expect(dot(n, ref.n)).toBeCloseTo(1, 6);
    expect(dot(u, ref.u)).toBeCloseTo(1, 6);
  });

  it('basisFromUp copes with the poles', () => {
    const { e, n, u } = basisFromUp([0, 0, 1]);
    expect(Math.hypot(...e)).toBeCloseTo(1, 9);
    expect(dot(e, u)).toBeCloseTo(0, 9);
    expect(dot(n, u)).toBeCloseTo(0, 9);
  });

  it('ellipsoid normal leans towards the equator relative to the radial direction', () => {
    const p = geodeticToFixed({ lat: 0.8, lon: 0.3, alt: 0 }, EARTH) as V3;
    const radial = [p[0], p[1], p[2]].map((x) => x / Math.hypot(...p)) as V3;
    const up = ellipsoidUp(p);
    expect(up[2]).toBeGreaterThan(radial[2]);
    expect(Math.asin(up[2])).toBeCloseTo(0.8, 3);
  });

  it('basisOffset places the camera: south of the target for north-up, higher with elevation', () => {
    const basis = basisFromUp([1, 0, 0]); // lat 0 lon 0: e=+Y n=+Z u=+X
    const flat = basisOffset(basis, -Math.PI / 2, 0, 100);
    expect(flat[0]).toBeCloseTo(0, 9); // no height
    expect(flat[2]).toBeCloseTo(-100, 9); // south = -Z
    const up45 = basisOffset(basis, -Math.PI / 2, Math.PI / 4, 100);
    expect(up45[0]).toBeCloseTo(70.710678, 4);
    expect(Math.hypot(...up45)).toBeCloseTo(100, 9);
  });

  it('slerpDir interpolates along the arc, handles equal and opposite directions', () => {
    const mid = slerpDir([1, 0, 0], [0, 1, 0], 0.5);
    expect(mid[0]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(mid[1]).toBeCloseTo(Math.SQRT1_2, 9);
    expect(slerpDir([1, 0, 0], [2, 0, 0], 0.3)).toEqual([1, 0, 0]);
    const half = slerpDir([1, 0, 0], [-1, 0, 0], 0.5);
    expect(Math.hypot(...half)).toBeCloseTo(1, 9);
    expect(Math.abs(half[0])).toBeLessThan(1e-9);
    expect(slerpDir([0, 0, 1], [0, 1, 0], 0)).toEqual([0, 0, 1]);
  });

  it('fitAngles tilts a small near-Earth subject towards an oblique north-facing view, big sets keep the outside view', () => {
    const small = fitAngles([RE + 10, 0, 0], 40)!;
    expect(small.az).toBeCloseTo(0, 9);
    expect(small.el).toBeCloseTo(-SMALL_FIT_TILT, 9); // camera swung south of the local vertical
    const big = fitAngles([0, 20000, 0], RE * 2)!;
    expect(big).toEqual(viewAnglesFor([0, 20000, 0]));
    const far = fitAngles([3e6, 0, 0], 100)!; // a shell probe is not "near Earth"
    expect(far).toEqual(viewAnglesFor([3e6, 0, 0]));
    expect(fitAngles([0, 0, 0], 10)).toBeNull();
  });

  it('viewAnglesFor points from the Earth through the subject, null near the centre', () => {
    expect(viewAnglesFor([100, 0, 0])).toBeNull();
    const v = viewAnglesFor([0, 20000, 0])!;
    expect(v.az).toBeCloseTo(Math.PI / 2, 9);
    expect(v.el).toBeCloseTo(0.3, 9);
  });
});

describe('surface view fit and ground pan', () => {
  it('frames an object together with the ground below it, from a distance that grows with its height', () => {
    const iss = surfaceFitDistance(420, 45, 1.6);
    expect(iss).toBeCloseTo(fitDistance(420, 45, 1.6, 1.25), 9);
    expect(iss).toBeGreaterThan(1000); // about 1,400 km
    expect(iss).toBeLessThan(2000);
    // a taller object needs a camera farther back
    expect(surfaceFitDistance(2000, 45, 1.6)).toBeGreaterThan(iss);
    // a narrow (portrait) window needs more distance than a wide one
    expect(surfaceFitDistance(420, 45, 0.5)).toBeGreaterThan(iss);
  });

  it('keeps ground-level objects at the minimum distance and very high ones at the zoom-out limit', () => {
    expect(surfaceFitDistance(0, 45, 1.6)).toBe(SURFACE_FIT_MIN_KM);
    expect(surfaceFitDistance(-5, 45, 1.6)).toBe(SURFACE_FIT_MIN_KM);
    expect(surfaceFitDistance(5, 45, 1.6)).toBe(SURFACE_FIT_MIN_KM); // a booster just off the pad
    expect(surfaceFitDistance(100, 45, 1.6)).toBeGreaterThan(SURFACE_FIT_MIN_KM); // a rocket in ascent
    expect(surfaceFitDistance(1e9, 45, 1.6)).toBe(SURFACE_FIT_MAX_KM); // a probe on the compressed shell
    expect(surfaceFitDistance(35786, 45, 0.1)).toBe(SURFACE_FIT_MAX_KM);
  });

  it('turns a drag into ground motion in the camera\'s own frame', () => {
    const north = -Math.PI / 2; // camera south of the target, looking north
    const right = groundPanDelta(north, 0.35, 10, 0, 1);
    expect(right.east).toBeCloseTo(-10, 9); // dragging right moves the target west
    expect(right.north).toBeCloseTo(0, 9);
    const down = groundPanDelta(north, Math.PI / 2, 0, 10, 1);
    expect(down.east).toBeCloseTo(0, 9);
    expect(down.north).toBeCloseTo(10, 9); // dragging down moves it forward, which is north here
    // looking east (camera west of the target) the same drag runs along the other axis
    const east = groundPanDelta(Math.PI, Math.PI / 2, 0, 10, 1);
    expect(east.east).toBeCloseTo(10, 9);
    expect(east.north).toBeCloseTo(0, 9);
    // a low camera stretches the forward component (foreshortening), capped at 5x
    expect(groundPanDelta(north, 0.01, 0, 10, 1).north).toBeCloseTo(50, 9);
  });

  it('moves a point over the sphere of its own radius, across the poles', () => {
    const r = RE + 420;
    const p: V3 = [r, 0, 0];
    const north = moveOnSphere(p, [0, 0, 10]);
    expect(Math.hypot(...north)).toBeCloseTo(r, 6);
    expect(Math.asin(north[2] / r) * r).toBeCloseTo(10, 4); // 10 km along the surface at that height
    expect(moveOnSphere(p, [0, 0, 0])).toEqual(p);
    expect(moveOnSphere(p, [5, 0, 0])).toEqual(p); // the part along the vertical is ignored
    // a quarter of the circumference north lands on the pole, twice that on the far side
    const pole = moveOnSphere(p, [0, 0, (Math.PI / 2) * r]);
    expect(pole[2]).toBeCloseTo(r, 6);
    expect(Math.hypot(pole[0], pole[1])).toBeLessThan(1e-6);
    const past = moveOnSphere(p, [0, 0, Math.PI * 0.75 * r]);
    expect(past[0]).toBeLessThan(0);
    expect(past[2]).toBeGreaterThan(0);
  });
});

describe('mode transition camera path', () => {
  const dir = (lat: number, lon: number): V3 => [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  const at = (lat: number, lon: number, alt: number): V3 => {
    const d = dir(lat, lon), r = surfaceRadius(d) + alt;
    return [d[0] * r, d[1] * r, d[2] * r];
  };
  const targets: V3[] = [at(0.3, 0.2, 0), at(0.9, -2, 420), at(-0.5, 3, 340), at(1.5, 1, 7)];
  /** a grid of start cameras: every side of the planet, from just above the ground out to 80,000 km */
  const starts: V3[] = [];
  for (const alt of [5, 300, 1100, 9000, 24000, 80000]) {
    for (let lat = -1.4; lat <= 1.41; lat += 0.7) for (let lon = -3; lon <= 3.1; lon += 1.0) starts.push(at(lat, lon, alt));
  }

  /** the surface camera for a target: 20 degrees up, `dist` away, south of it (the real end pose) */
  const endFor = (t: V3, dist: number): V3 => {
    const o = basisOffset(basisFromUp(ellipsoidUp(t)), -Math.PI / 2, 0.35, dist);
    return [t[0] + o[0], t[1] + o[1], t[2] + o[2]];
  };

  it('starts at the old pose and ends at the new one', () => {
    const a = at(0.2, 1, 24000), b = at(0.4, 1.1, 300);
    expect(blendPosition(a, b, 0)).toEqual(a);
    expect(blendPosition(a, b, 1)).toEqual(b);
  });

  it('keeps the camera above MIN_ALT_KM and the lower of its two heights, for every start and end', () => {
    for (const t of targets) for (const dist of [20, 500, 1400]) {
      const end = endFor(t, dist);
      for (const s of starts) {
        const floor = Math.min(Math.max(MIN_ALT_KM, altitudeOf(s)), Math.max(MIN_ALT_KM, altitudeOf(end)));
        for (let k = 0.02; k < 1; k += 0.02) {
          expect(altitudeOf(blendPosition(s, end, k, MIN_ALT_KM, t))).toBeGreaterThanOrEqual(floor - 1e-6);
        }
      }
    }
  });

  it('never goes lower than the horizon it starts or ends at, as seen from the target', () => {
    for (const t of targets) for (const dist of [20, 500, 1400]) {
      const end = endFor(t, dist);
      for (const s of starts) {
        const floor = Math.min(elevationAbout(s, t), elevationAbout(end, t));
        for (let k = 0.02; k < 1; k += 0.02) {
          expect(elevationAbout(blendPosition(s, end, k, MIN_ALT_KM, t), t)).toBeGreaterThanOrEqual(floor - 1e-9);
        }
      }
    }
  });

  it('does not pass through the planet when the camera starts on the far side', () => {
    const t = at(0, 0, 420);
    const s = at(0, Math.PI, 24000); // behind the Earth as seen from the target
    const end = endFor(t, 1400);
    for (let k = 0.01; k < 1; k += 0.01) expect(altitudeOf(blendPosition(s, end, k, MIN_ALT_KM, t))).toBeGreaterThan(MIN_ALT_KM - 1e-6);
  });

  it('falls steadily in height (constant factor per step) without a target to keep above', () => {
    const a = at(0, 0, 10000), b = at(0, 0, 100);
    const alt = (k: number) => altitudeOf(blendPosition(a, b, k));
    expect(alt(0.5)).toBeCloseTo(1000, 3);
    expect(alt(0.25) / alt(0)).toBeCloseTo(alt(0.5) / alt(0.25), 6);
  });

  it('lifts a low camera to the given elevation, keeping its distance and azimuth', () => {
    const t = at(0.4, 0.5, 420);
    const b = basisFromUp(ellipsoidUp(t));
    const o = basisOffset(b, 1.2, -0.3, 900);
    const p: V3 = [t[0] + o[0], t[1] + o[1], t[2] + o[2]];
    expect(elevationAbout(p, t)).toBeCloseTo(-0.3, 9);
    const q = liftToElevation(p, t, 0.2);
    expect(elevationAbout(q, t)).toBeCloseTo(0.2, 9);
    expect(dist3(q, t)).toBeCloseTo(900, 6);
    const want = basisOffset(b, 1.2, 0.2, 900);
    expect(dist3(q, [t[0] + want[0], t[1] + want[1], t[2] + want[2]])).toBeLessThan(1e-6);
    expect(altitudeOf(q)).toBeGreaterThan(altitudeOf(p));
    // already high enough: untouched; straight below: lifted without NaN
    expect(liftToElevation(p, t, -0.5)).toBe(p);
    const u = ellipsoidUp(t);
    const below = liftToElevation([t[0] - u[0] * 100, t[1] - u[1] * 100, t[2] - u[2] * 100], t, 0.3);
    expect(elevationAbout(below, t)).toBeCloseTo(0.3, 9);
  });
});
