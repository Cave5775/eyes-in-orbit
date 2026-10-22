import { describe, expect, it } from 'vitest';
import { EARTH, geodeticToFixed } from '@eio/core';
import { ELLIPSOID_K, earthOccludes, horizonDistanceKm, occlusionC2 } from '../src/lib/occlusion';
import type { V3 } from '../src/lib/camera';

const RE = EARTH.radiusKm;
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

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
