import { describe, expect, it } from 'vitest';
import { EARTH, geodeticToFixed } from '@eio/core';
import { ELLIPSOID_K, chordSagKm, earthOccludes, horizonDistanceKm, makeOccluder, occlusionC2, sphereOccludes, sphereView } from '../src/lib/occlusion';
import type { V3 } from '../src/lib/camera';

const RE = EARTH.radiusKm;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

describe('chordSagKm', () => {
  it('matches the closed form and grows with the square of the chord', () => {
    expect(chordSagKm(0)).toBe(0);
    expect(chordSagKm(700)).toBeCloseTo(9.6, 1); // a 700 km ground-track segment sinks ~10 km below the surface
    expect(chordSagKm(78)).toBeCloseTo(0.12, 2); // one facet of the 512-segment Earth mesh
    expect(chordSagKm(1400) / chordSagKm(700)).toBeGreaterThan(3.9);
  });
});

describe('earthOccludes', () => {
  it('hides a point on the far side of the Earth and shows one in front', () => {
    const cam: V3 = [RE + 1000, 0, 0];
    expect(earthOccludes(cam, sub([-RE - 500, 0, 0], cam))).toBe(true);
    expect(earthOccludes(cam, sub([RE + 500, 0, 0], cam))).toBe(false);
    // sideways, well above the limb
    expect(earthOccludes(cam, sub([RE + 1000, 20000, 0], cam))).toBe(false);
  });

  it('a camera in orbit sees a satellite just past the limb only when it is above the horizon line', () => {
    const cam: V3 = [RE + 400, 0, 0];
    // horizon distance from 400 km: sqrt(2 R h + h^2) ~ 2294 km; a point 7000 km out sideways at altitude 400 is hidden, at altitude 3000 it is visible
    const lowFar: V3 = [Math.cos(1) * (RE + 400), Math.sin(1) * (RE + 400), 0]; // 57 degrees round the Earth
    expect(earthOccludes(cam, sub(lowFar, cam))).toBe(true);
    const highFar: V3 = [Math.cos(0.6) * (RE + 3000), Math.sin(0.6) * (RE + 3000), 0];
    expect(earthOccludes(cam, sub(highFar, cam))).toBe(false);
  });

  it('never hides a marker standing on the ground from a camera above it, at any latitude (ellipsoid)', () => {
    for (const lat of [-89, -60, -30, 0, 28.5, 45, 70, 89]) {
      for (const lon of [-170, -80, 0, 100]) {
        const g = geodeticToFixed({ lat: (lat * Math.PI) / 180, lon: (lon * Math.PI) / 180, alt: 0 }, EARTH) as V3;
        const up = geodeticToFixed({ lat: (lat * Math.PI) / 180, lon: (lon * Math.PI) / 180, alt: 3 }, EARTH) as V3; // 3 km straight up
        const cam: V3 = [up[0] + 5, up[1] + 5, up[2]]; // roughly above the marker
        expect(earthOccludes(cam, sub(g, cam)), `lat ${lat} lon ${lon}`).toBe(false);
        // and from 600 km straight up
        const high = geodeticToFixed({ lat: (lat * Math.PI) / 180, lon: (lon * Math.PI) / 180, alt: 600 }, EARTH) as V3;
        expect(earthOccludes(high, sub(g, high)), `high lat ${lat} lon ${lon}`).toBe(false);
      }
    }
  });

  it('hides a ground marker that is round the horizon from a low camera, and shows one just inside it', () => {
    const cam: V3 = [RE + 3, 0, 0]; // 3 km up on the equator: horizon at ~195 km
    const at = (km: number): V3 => [RE * Math.cos(km / RE), RE * Math.sin(km / RE), 0];
    expect(earthOccludes(cam, sub(at(120), cam))).toBe(false);
    expect(earthOccludes(cam, sub(at(400), cam))).toBe(true);
  });

  it('makeOccluder agrees with earthOccludes', () => {
    const cam: V3 = [RE + 3, 40, -20];
    const occ = makeOccluder(cam);
    let hidden = 0;
    for (let i = 0; i < 400; i++) {
      const a = i * 0.7, b = i * 0.31;
      const p: V3 = [Math.cos(a) * Math.cos(b) * (RE + (i % 7) * 900), Math.sin(a) * Math.cos(b) * (RE + (i % 5) * 400), Math.sin(b) * (RE + (i % 3) * 5000)];
      const rel = sub(p, cam);
      expect(occ(rel[0], rel[1], rel[2])).toBe(earthOccludes(cam, rel));
      if (occ(rel[0], rel[1], rel[2])) hidden++;
    }
    expect(hidden).toBeGreaterThan(50);
    expect(400 - hidden).toBeGreaterThan(20);
  });

  it('treats a camera inside the planet as seeing everything (nothing sensible to hide)', () => {
    expect(earthOccludes([10, 0, 0], [RE, 0, 0])).toBe(false);
  });

  it('exposes the c2 term used by the shader: positive outside, scaled in z by the flattening', () => {
    expect(occlusionC2([RE + 1000, 0, 0])).toBeGreaterThan(0);
    // polar axis: the ellipsoid is shorter there, so the same geocentric radius is further outside
    const polar = occlusionC2([0, 0, RE * (1 - EARTH.flattening) + 10]);
    expect(polar).toBeGreaterThan(0);
    expect(ELLIPSOID_K).toBeGreaterThan(1);
  });

  it('horizonDistance matches the closed form', () => {
    expect(horizonDistanceKm(0)).toBe(0);
    expect(horizonDistanceKm(3)).toBeCloseTo(Math.sqrt(2 * RE * 3 + 9), 6);
    expect(horizonDistanceKm(400)).toBeGreaterThan(2200);
  });
});

describe('sphere occluders (Moon and Sun)', () => {
  const MOON_R = 1737.4;
  const SUN_R = 695700;
  const moonC: V3 = [384400, 0, 0];

  it('hides a point behind the sphere, not one in front, beside it or on its near surface', () => {
    const cam: V3 = [RE + 400, 0, 0];
    const occ = makeOccluder(cam, undefined, [{ c: moonC, r: MOON_R }]);
    const rel = (p: V3) => sub(p, cam);
    const hidden = (p: V3) => occ(...rel(p));
    expect(hidden([moonC[0] + 5000, 0, 0])).toBe(true); // far behind the Moon
    expect(hidden([moonC[0] + 100, 0, 0])).toBe(true); // just behind its centre
    expect(hidden([moonC[0] + 100, 1700, 0])).toBe(true); // behind, near the limb
    expect(hidden([moonC[0] + 100, 1800, 0])).toBe(false); // beside the limb
    expect(hidden([moonC[0] + 100, 0, -9000])).toBe(false); // beside
    expect(hidden([moonC[0] - 5000, 0, 0])).toBe(false); // between the camera and the Moon
    expect(hidden([moonC[0] - MOON_R + 0.05, 0, 0])).toBe(false); // on the near surface (a lander): margin keeps it shown
    expect(hidden([moonC[0] - MOON_R - 5, 0, 0])).toBe(false); // just above the near surface
    expect(hidden([moonC[0] + MOON_R + 5, 0, 0])).toBe(true); // just past the far surface
    const far = makeOccluder([1e6, 0, 0], undefined, [{ c: moonC, r: MOON_R }]); // camera beyond the Moon
    expect(far(1e6, 0, 0)).toBe(false); // looking away from it
  });

  it('agrees with a brute-force segment-vs-sphere test', () => {
    const cam: V3 = [123456, -2e5, 3e4];
    const c: V3 = [cam[0] + 40000, cam[1] + 10000, cam[2] - 5000];
    const r = 6000;
    const v = sphereView(cam, { c, r }, 0);
    let hit = 0;
    for (let i = 0; i < 3000; i++) {
      // directions within about 3 angular radii of the sphere's centre, so a good share of the cases hit it
      const ax: V3 = [c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]];
      const cd = Math.hypot(...ax);
      const a = i * 0.913, spread = ((i % 23) / 23) * 3 * (r / cd);
      const tilt: V3 = [Math.cos(a) * spread * cd, Math.sin(a) * spread * cd, Math.sin(a * 1.7) * spread * cd];
      const d = 5000 + (i % 17) * 6000;
      const dir: V3 = [ax[0] + tilt[0], ax[1] + tilt[1], ax[2] + tilt[2]];
      const dn = Math.hypot(...dir);
      const rel: V3 = [(dir[0] / dn) * d, (dir[1] / dn) * d, (dir[2] / dn) * d];
      // reference: the closest point of the segment camera -> point to the centre lies inside the sphere
      const C: V3 = [c[0] - cam[0], c[1] - cam[1], c[2] - cam[2]];
      const t = Math.min(1, Math.max(0, (rel[0] * C[0] + rel[1] * C[1] + rel[2] * C[2]) / (d * d)));
      const miss = Math.hypot(rel[0] * t - C[0], rel[1] * t - C[1], rel[2] * t - C[2]);
      const got = sphereOccludes(v, rel[0], rel[1], rel[2]);
      expect(got, `case ${i}`).toBe(miss < r);
      if (got) hit++;
    }
    expect(hit).toBeGreaterThan(100);
    expect(hit).toBeLessThan(2900);
  });

  it('ignores a sphere the camera is inside, and a radius of zero', () => {
    const cam: V3 = [moonC[0] + 500, 0, 0]; // inside the Moon
    const occ = makeOccluder(cam, undefined, [{ c: moonC, r: MOON_R }]);
    expect(occ(1e6, 0, 0)).toBe(false);
    const never = makeOccluder([RE + 400, 0, 0], undefined, [{ c: [0, 0, 0], r: 0 }]);
    expect(never(1000, 0, 0)).toBe(false);
  });

  it('keeps the Earth path unchanged and combines with the spheres', () => {
    const cam: V3 = [RE + 1000, 0, 0];
    const plain = makeOccluder(cam);
    const both = makeOccluder(cam, undefined, [{ c: moonC, r: MOON_R }]);
    for (let i = 0; i < 300; i++) {
      const a = i * 0.7, b = i * 0.31;
      const p: V3 = [Math.cos(a) * Math.cos(b) * (RE + (i % 7) * 900), Math.sin(a) * Math.cos(b) * (RE + (i % 5) * 400), Math.sin(b) * (RE + (i % 3) * 5000)];
      const rel = sub(p, cam);
      expect(both(rel[0], rel[1], rel[2])).toBe(plain(rel[0], rel[1], rel[2])); // nothing near the Moon
    }
    expect(both(...sub([-RE - 500, 0, 0], cam))).toBe(true); // Earth still hides
    expect(both(...sub([moonC[0] + 10, 0, 0], cam))).toBe(true); // and so does the Moon
    expect(both(...sub([RE + 500, 0, 0], cam))).toBe(false);
  });

  it('works with the Moon camera view: points behind the lunar limb are hidden, the sky above is not', () => {
    const cam: V3 = [moonC[0], moonC[1] + MOON_R * 1.5, moonC[2]]; // 870 km above the surface
    const occ = makeOccluder(cam, undefined, [{ c: moonC, r: MOON_R }]);
    expect(occ(...sub([moonC[0], moonC[1] - MOON_R - 300, moonC[2]], cam))).toBe(true); // far side
    expect(occ(...sub([moonC[0], moonC[1] + MOON_R + 300, moonC[2]], cam))).toBe(false); // above the camera's surface
  });

  /** Float32 mirror of the shader's sphere test (every operation rounded), inputs rounded as the uniforms and attributes are. */
  function shaderSphere(cRel: V3, r: number, c2: number, rel: V3): boolean {
    const f = Math.fround;
    const cx = f(cRel[0]), cy = f(cRel[1]), cz = f(cRel[2]);
    const px = f(rel[0]), py = f(rel[1]), pz = f(rel[2]);
    const L = f(Math.sqrt(f(f(f(px * px) + f(py * py)) + f(pz * pz))));
    if (L <= 0) return false;
    const ux = f(px / L), uy = f(py / L), uz = f(pz / L);
    const b = f(f(f(ux * cx) + f(uy * cy)) + f(uz * cz));
    if (b <= 0) return false;
    const x = f(f(uy * cz) - f(uz * cy)), y = f(f(uz * cx) - f(ux * cz)), z = f(f(ux * cy) - f(uy * cx));
    const p = f(Math.sqrt(f(f(f(x * x) + f(y * y)) + f(z * z))));
    const R = f(r);
    if (p >= R) return false;
    const root = f(Math.sqrt(f(f(R - p) * f(R + p))));
    return f(f(c2) / f(b + root)) < L;
  }

  it('stays accurate in float32 for the Sun at 1.5e8 km (true scale) and for the compressed Sun', () => {
    for (const [dist, radius] of [[1.496e8, SUN_R], [2.4e6, SUN_R * (2.4e6 / 1.496e8)]] as const) {
      const cam: V3 = [3e6, -1e6, 2e5]; // somewhere near the Earth, in display space
      const dir: V3 = [0.8, 0.5, 0.33166];
      const n = Math.hypot(...dir);
      const c: V3 = [dir[0] / n * dist, dir[1] / n * dist, dir[2] / n * dist];
      const v = sphereView(cam, { c, r: radius });
      const ang = radius / dist; // angular radius, rad
      let agree = 0, hid = 0;
      for (let i = 0; i < 4000; i++) {
        // points at various distances in directions within +-2 angular radii of the Sun
        const k = (i % 40) / 40 * 2 * ang, phi = i * 0.618;
        const cd = Math.hypot(v.x, v.y, v.z);
        const ax: V3 = [v.x / cd, v.y / cd, v.z / cd];
        const e1: V3 = [-ax[1], ax[0], 0];
        const e1n = Math.hypot(...e1);
        const e2: V3 = [ax[1] * e1[2] / e1n - ax[2] * e1[1] / e1n, ax[2] * e1[0] / e1n - ax[0] * e1[2] / e1n, ax[0] * e1[1] / e1n - ax[1] * e1[0] / e1n];
        const d = cd + [-3, -1.2, -0.5, 0, 0.5, 1.2, 3][i % 7] * v.r;
        const dirv: V3 = [0, 1, 2].map((j) => ax[j] + k * (Math.cos(phi) * e1[j] / e1n + Math.sin(phi) * e2[j])) as V3;
        const dn = Math.hypot(...dirv);
        const rel: V3 = [dirv[0] / dn * d, dirv[1] / dn * d, dirv[2] / dn * d];
        // keep away from the exact grazing and surface-crossing cases, where float32 may legitimately differ
        const exact = sphereOccludes(v, rel[0], rel[1], rel[2]);
        const wiggle = (s: number) => sphereOccludes(v, rel[0] * s, rel[1] * s, rel[2] * s);
        if (wiggle(0.9995) !== exact || wiggle(1.0005) !== exact) continue;
        agree++;
        if (exact) hid++;
        expect(shaderSphere([v.x, v.y, v.z], v.r, v.c2, rel), `dist ${dist} case ${i}`).toBe(exact);
      }
      expect(agree).toBeGreaterThan(1500);
      expect(hid).toBeGreaterThan(300);
      expect(agree - hid).toBeGreaterThan(300);
    }
  });
});
