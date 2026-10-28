import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { MARS, MOON, bodyEntityRecords, inertialToFixedMatrix, mulMV, type Vec3 } from '@eio/core';
import { bodyFixedToInertial, fitMapSize, poleDirection } from '../src/lib/body-map';
import { CelestialLayer, createMapSphere, type MapEnv } from '../src/scene/celestial';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

describe('fitMapSize', () => {
  it('keeps a map the GPU can hold and scales a wider one down to the limit, keeping the aspect ratio', () => {
    expect(fitMapSize(4096, 2048, 8192)).toEqual({ width: 4096, height: 2048, scaled: false });
    expect(fitMapSize(4096, 2048, 4096)).toEqual({ width: 4096, height: 2048, scaled: false });
    expect(fitMapSize(8192, 4096, 4096)).toEqual({ width: 4096, height: 2048, scaled: true });
    expect(fitMapSize(4096, 2048, 2000)).toEqual({ width: 2000, height: 1000, scaled: true });
  });
});

describe('body orientation of a mapped sphere', () => {
  it('the geometry z axis (the texture poles) maps to the IAU pole direction in the inertial frame', () => {
    for (const body of [MARS, MOON]) {
      const pole = poleDirection(body);
      for (const t of [T0, T0 + 3.7 * 3_600_000, Date.UTC(2030, 0, 1), Date.UTC(2000, 0, 1, 12)]) {
        const z = mulMV(bodyFixedToInertial(body, t), [0, 0, 1]);
        for (let i = 0; i < 3; i++) expect(z[i]).toBeCloseTo(pole[i], 12);
      }
    }
    // Mars' pole is at RA 317.68, Dec 52.89: in the +x, -y, +z octant, 37.1 degrees from the Earth's pole
    const p = poleDirection(MARS);
    expect(p[0]).toBeGreaterThan(0);
    expect(p[1]).toBeLessThan(0);
    expect(Math.acos(p[2]) * (180 / Math.PI)).toBeCloseTo(90 - 52.8865, 6);
  });

  it('the prime meridian (+x) lies in the equator and advances east with the rotation', () => {
    const dt = 60_000;
    const a = mulMV(bodyFixedToInertial(MARS, T0), [1, 0, 0]);
    const b = mulMV(bodyFixedToInertial(MARS, T0 + dt), [1, 0, 0]);
    const pole = poleDirection(MARS);
    expect(dot(a, pole)).toBeCloseTo(0, 12);
    // counterclockwise about the north pole = prograde rotation
    expect(dot(cross(a, b), pole)).toBeGreaterThan(0);
    // 350.892 deg/day
    const ang = Math.acos(Math.min(1, dot(a, b))) * (180 / Math.PI);
    expect(ang).toBeCloseTo((350.89198226 / 1440) % 360, 4);
  });

  it('is the inverse of the inertial-to-fixed matrix (a body-fixed surface point round-trips)', () => {
    const lon = (-133.8 * Math.PI) / 180, lat = (18.65 * Math.PI) / 180; // Olympus Mons
    const fixed: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    const inertial = mulMV(bodyFixedToInertial(MARS, T0), fixed);
    const back = mulMV(inertialToFixedMatrix(MARS, T0), inertial);
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(fixed[i], 12);
  });
});

describe('createMapSphere (the layout of the map on the sphere)', () => {
  const g = createMapSphere(100, 64, 32);
  const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
  const at = (u: number, v: number): Vec3 => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < uv.count; i++) {
      const d = (uv.getX(i) - u) ** 2 + (uv.getY(i) - v) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return [pos.getX(best), pos.getY(best), pos.getZ(best)];
  };

  it('has the map centre (u = 0.5, equator) on +x and the poles on +-z', () => {
    const c = at(0.5, 0.5);
    expect(c[0]).toBeCloseTo(100, 6);
    expect(Math.abs(c[1])).toBeLessThan(1e-6);
    expect(Math.abs(c[2])).toBeLessThan(1e-6);
    expect(at(0.5, 1)[2]).toBeCloseTo(100, 6);
    expect(at(0.5, 0)[2]).toBeCloseTo(-100, 6);
  });

  it('puts east (u growing, longitude growing) towards +y: the map is not mirrored', () => {
    // 90 degrees east of the prime meridian is u = 0.75, 90 degrees west u = 0.25
    const east = at(0.75, 0.5), west = at(0.25, 0.5);
    expect(east[1]).toBeCloseTo(100, 6);
    expect(west[1]).toBeCloseTo(-100, 6);
    // the date line is at u = 0 / 1
    expect(at(0, 0.5)[0]).toBeCloseTo(-100, 6);
  });
});

/** The layer holding only Mars, with a texture loader the test controls. */
function marsLayer(loadTexture: MapEnv['loadTexture'], env: Partial<MapEnv> = {}) {
  const scene = new THREE.Scene();
  const layer = new CelestialLayer(scene, new THREE.Vector3(1, 0, 0), { loadTexture, ...env });
  layer.setBodies(bodyEntityRecords().filter((r) => r.id === 'body-mars'));
  const mesh = scene.children.find((o) => o instanceof THREE.Mesh) as THREE.Mesh;
  return { scene, layer, mesh };
}

describe('Mars in the celestial layer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is a sphere of the equatorial radius whose pole axis follows the IAU pole as it is placed', () => {
    const { layer, mesh } = marsLayer(() => undefined);
    expect((mesh.geometry as THREE.SphereGeometry).parameters.radius).toBe(MARS.radiusKm);
    for (const t of [T0, T0 + 86_400_000 * 100]) {
      layer.update(t, new THREE.Vector3());
      const z = new THREE.Vector3(0, 0, 1).applyQuaternion(mesh.quaternion);
      const pole = poleDirection(MARS);
      expect(z.x).toBeCloseTo(pole[0], 6);
      expect(z.y).toBeCloseTo(pole[1], 6);
      expect(z.z).toBeCloseTo(pole[2], 6);
      // and the prime meridian direction is the matrix's x column
      const x = new THREE.Vector3(1, 0, 0).applyQuaternion(mesh.quaternion);
      const m = mulMV(bodyFixedToInertial(MARS, t), [1, 0, 0]);
      expect(x.x).toBeCloseTo(m[0], 6);
      expect(x.y).toBeCloseTo(m[1], 6);
      expect(x.z).toBeCloseTo(m[2], 6);
    }
  });

  it('keeps the tinted fallback and says how to get the map when the texture is missing', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { mesh } = marsLayer((_url, _ok, fail) => fail());
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.uTint).toBeDefined();
    expect(mat.uniforms.uTex).toBeUndefined();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('npm run assets'));
  });

  it('asks for /textures/mars.jpg, and a loaded map replaces the tinted material', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const urls: string[] = [];
    const tex = new THREE.Texture({ width: 4096, height: 2048 } as unknown as HTMLImageElement);
    const { mesh } = marsLayer((url, ok) => { urls.push(url); ok(tex); });
    expect(urls).toEqual(['/textures/mars.jpg']);
    const mat = mesh.material as THREE.ShaderMaterial;
    expect(mat.uniforms.uTex.value).toBe(tex);
    expect(mat.uniforms.uHasTex.value).toBe(1);
    expect(tex.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('drops a map that arrives after Mars left the layer', () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    let finish: (t: THREE.Texture) => void = () => undefined;
    const { layer, mesh } = marsLayer((_u, ok) => { finish = ok; });
    layer.setBodies([]);
    const tex = new THREE.Texture({ width: 2048, height: 1024 } as unknown as HTMLImageElement);
    const dispose = vi.spyOn(tex, 'dispose');
    finish(tex);
    expect(dispose).toHaveBeenCalled();
    expect((mesh.material as THREE.ShaderMaterial).uniforms.uTex).toBeUndefined();
  });
});
