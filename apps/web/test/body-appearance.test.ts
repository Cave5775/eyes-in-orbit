import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { defaultBodies, bodyEntityRecords } from '@eio/core';
import { BODY_STYLES, DEFAULT_STYLE, MARKER_BELOW_PX, MARKER_SIZE_PX, SATURN_RINGS, bodyStyle, hexRgb, ringSample, ringTexture } from '../src/lib/body-style';
import { OccluderSet, sphereView, type SceneBody } from '../src/lib/occlusion';
import { refPositionEci } from '../src/lib/ref-body';
import { CelestialLayer } from '../src/scene/celestial';
import { createBodyMaterial } from '../src/scene/materials';
import type { V3 } from '../src/lib/camera';
import { glslBodyHides } from './glsl-occlusion';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const HEX = /^#[0-9a-f]{6}$/i;

describe('body styles (lib/body-style.ts)', () => {
  it('every registry body has its own style with valid colours, and unknown bodies fall back to the neutral grey', () => {
    for (const b of defaultBodies.all()) {
      const st = BODY_STYLES[b.id];
      expect(st, b.id).toBeDefined();
      expect(st.color, b.id).toMatch(HEX);
      for (const c of st.bands?.colors ?? []) expect(c).toMatch(HEX);
      if (st.bands) expect(st.bands.count).toBeGreaterThan(0);
      if (st.noise !== undefined) expect(st.noise).toBeGreaterThanOrEqual(0);
    }
    expect(bodyStyle('NOT_A_BODY')).toBe(DEFAULT_STYLE);
    expect(DEFAULT_STYLE.color).toMatch(HEX);
    expect(hexRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
    expect(hexRgb('nonsense')).toEqual(hexRgb(DEFAULT_STYLE.color));
  });

  it('the giants have bands, Saturn has rings, the small bodies are plain', () => {
    for (const id of ['JUPITER', 'SATURN', 'URANUS', 'NEPTUNE']) expect(BODY_STYLES[id].bands, id).toBeDefined();
    for (const id of ['IO', 'TITAN', 'CERES', 'PLUTO', 'MOON']) expect(BODY_STYLES[id].bands, id).toBeUndefined();
    expect(Object.keys(BODY_STYLES).filter((k) => BODY_STYLES[k].rings)).toEqual(['SATURN']);
  });

  it('the Jupiter and Saturn palettes read as tan/cream and pale gold (red above blue)', () => {
    for (const id of ['JUPITER', 'SATURN', 'IO', 'TITAN', 'MARS']) {
      const [r, , b] = hexRgb(BODY_STYLES[id].color);
      expect(r, id).toBeGreaterThan(b);
    }
    const [ur, , ub] = hexRgb(BODY_STYLES.URANUS.color), [nr, , nb] = hexRgb(BODY_STYLES.NEPTUNE.color);
    expect(ub).toBeGreaterThan(ur);
    expect(nb).toBeGreaterThan(nr);
  });

  it('the body material carries the style colour and the band parameters', () => {
    const m = createBodyMaterial(new THREE.Vector3(1, 0, 0), BODY_STYLES.JUPITER);
    expect((m.uniforms.uTint.value as THREE.Vector3).toArray()).toEqual(hexRgb(BODY_STYLES.JUPITER.color));
    expect(m.uniforms.uBandN.value).toBe(BODY_STYLES.JUPITER.bands!.count);
    const plain = createBodyMaterial(new THREE.Vector3(1, 0, 0), BODY_STYLES.IO);
    expect(plain.uniforms.uBandN.value).toBe(0);
    expect(plain.fragmentShader).toContain('logdepthbuf_fragment');
  });
});

describe("Saturn's ring profile", () => {
  const r = SATURN_RINGS;
  it('spans 74,500 to 136,800 km, is clear outside, faint in C, dense in B, nearly empty in the Cassini division, moderate in A', () => {
    expect([r.innerKm, r.outerKm]).toEqual([74_500, 136_800]);
    expect(ringSample(r, 70_000).alpha).toBe(0);
    expect(ringSample(r, 140_000).alpha).toBe(0);
    const c = ringSample(r, 85_000).alpha, b = ringSample(r, 105_000).alpha, cass = ringSample(r, 120_000).alpha, a = ringSample(r, 130_000).alpha;
    expect(c).toBeGreaterThan(0.05);
    expect(c).toBeLessThan(0.25);
    expect(b).toBeGreaterThan(0.7);
    expect(cass).toBeLessThan(0.1);
    expect(a).toBeGreaterThan(0.3);
    expect(a).toBeLessThan(b);
  });

  it('the texture samples that profile from the inner to the outer edge', () => {
    const w = 512, tex = ringTexture(r, w);
    expect(tex.length).toBe(w * 4);
    const at = (km: number) => tex[Math.floor(((km - r.innerKm) / (r.outerKm - r.innerKm)) * w) * 4 + 3] / 255;
    expect(at(105_000)).toBeGreaterThan(at(120_000) * 5);
    expect(at(120_000)).toBeLessThan(0.1);
  });
});

/** A layer holding the given registry bodies (entities from the core records), no GPU. */
function layerOf(ids: string[], pointMaterial?: THREE.Material) {
  const scene = new THREE.Scene();
  const layer = new CelestialLayer(scene, new THREE.Vector3(1, 0, 0), { pointMaterial, loadTexture: () => undefined });
  layer.setBodies(bodyEntityRecords().filter((rec) => ids.includes(rec.id.replace('body-', '').toUpperCase())));
  return { scene, layer };
}

describe('flattened bodies in the celestial layer', () => {
  const sat = defaultBodies.get('SATURN');
  const { scene, layer } = layerOf(['SATURN', 'JUPITER']);
  const origin = new THREE.Vector3(...refPositionEci('SATURN', T0)).add(new THREE.Vector3(1e6, 2e6, 3e6));
  layer.update(T0, origin);
  const body = layer.bodies().find((b) => b.entityId === 'body-saturn')!;

  it('the drawn polar radius of Saturn is R (1 - f) along its pole, the equatorial one R', () => {
    const meshes = scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && (o.geometry as THREE.SphereGeometry).parameters?.radius === sat.radiusKm);
    expect(meshes.length).toBe(1);
    const mesh = meshes[0];
    mesh.updateMatrixWorld(true);
    const centre = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    const pole = new THREE.Vector3(...body.pole!);
    const top = new THREE.Vector3(0, 0, sat.radiusKm).applyMatrix4(mesh.matrixWorld).sub(centre);
    expect(top.length()).toBeCloseTo(sat.radiusKm * (1 - sat.flattening), 3);
    expect(top.clone().normalize().dot(pole)).toBeCloseTo(1, 9);
    const eq = new THREE.Vector3(sat.radiusKm, 0, 0).applyMatrix4(mesh.matrixWorld).sub(centre);
    expect(eq.length()).toBeCloseTo(sat.radiusKm, 3);
    expect(body.flattening).toBe(sat.flattening);
  });

  it('the occluder agrees with the mesh just inside and outside the (tilted) pole', () => {
    const pole = body.pole!;
    expect(Math.hypot(...pole)).toBeCloseTo(1, 12);
    expect(Math.abs(pole[2])).toBeLessThan(0.999); // tilted, not the Earth's z
    // camera on the pole axis, 5 radii out; points on the axis between it and the body
    const R = sat.radiusKm, b = R * (1 - sat.flattening);
    const cam: V3 = [body.c[0] + pole[0] * 5 * R, body.c[1] + pole[1] * 5 * R, body.c[2] + pole[2] * 5 * R];
    layer.update(T0, new THREE.Vector3(...cam));
    const set = new OccluderSet();
    set.build(layer.bodies(), 45, 700);
    const at = (s: number): V3 => [body.c[0] + pole[0] * s - cam[0], body.c[1] + pole[1] * s - cam[1], body.c[2] + pole[2] * s - cam[2]];
    expect(set.hides(...at(b * 0.99))).toBe(true); // inside the oblate body (but outside the pole-radius sphere ... near the surface)
    expect(set.hides(...at(b * 0.9))).toBe(true);
    expect(set.hides(...at(b + 5))).toBe(false); // just above the pole
    expect(set.hides(...at(R * 0.97))).toBe(false); // a sphere of radius R would have hidden this one
    // and seen from the equator the full R counts
    const eqDir = new THREE.Vector3(...pole).cross(new THREE.Vector3(0, 0, 1)).normalize();
    const cam2 = new THREE.Vector3(...body.c).addScaledVector(eqDir, 5 * R);
    layer.update(T0, cam2);
    set.build(layer.bodies(), 45, 700);
    const eqAt = (s: number): V3 => [body.c[0] + eqDir.x * s - cam2.x, body.c[1] + eqDir.y * s - cam2.y, body.c[2] + eqDir.z * s - cam2.z];
    expect(set.hides(...eqAt(R * 0.99))).toBe(true);
    expect(set.hides(...eqAt(R + 5))).toBe(false);
  });

  it('the float32 point shader emulation agrees with the CPU test for a tilted oblate body', () => {
    const pole = new THREE.Vector3(0.3, -0.5, 0.8).normalize().toArray() as V3;
    const sb: SceneBody = { entityId: 'x', c: [0, 0, 0], rel: [4e5, -2e5, 3e5], radiusKm: 60_268, k: 1, flattening: 0.09796, pole };
    const set = new OccluderSet();
    set.build([sb], 45, 700);
    expect(set.count).toBe(1);
    let n = 0, hid = 0;
    for (let i = 0; i < 400; i++) {
      // points around the body's line of sight, in front of it, inside it and behind it, within +-9e4 km of the axis
      const f = 0.6 + 0.8 * ((i * 0.37) % 1), j = (k: number) => 1.8e5 * (((i * k) % 1) - 0.5);
      const p: V3 = [sb.rel[0] * f + j(0.618034), sb.rel[1] * f + j(0.754877), sb.rel[2] * f + j(0.569840)];
      const cpu = set.hides(...p), gpu = glslBodyHides(set, ...p);
      if (cpu !== gpu) n++;
      if (cpu) hid++;
    }
    expect(hid).toBeGreaterThan(20);
    expect(n).toBeLessThanOrEqual(1);
    // a z-aligned default pole behaves exactly like the old z scale
    const v = sphereView([0, 0, 1e5], 6378.137, 1 / 298.257223563);
    expect([v.pxa, v.pya, v.pza]).toEqual([0, 0, 1]);
    expect(v.z).toBeCloseTo(1e5 / (1 - 1 / 298.257223563), 6);
  });

  it('Saturn has a ring mesh in its equatorial plane, outside the occluder list', () => {
    const rings = scene.children.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh && o.geometry instanceof THREE.RingGeometry);
    expect(rings.length).toBe(1);
    layer.update(T0, origin);
    const ring = rings[0];
    const mat = ring.material as THREE.ShaderMaterial;
    expect(mat.side).toBe(THREE.DoubleSide);
    expect(mat.transparent).toBe(true);
    expect(mat.fragmentShader).toContain('logdepthbuf_fragment');
    expect(mat.vertexShader).toContain('logdepthbuf_vertex');
    const n = new THREE.Vector3(0, 0, 1).applyQuaternion(ring.quaternion);
    expect(n.dot(new THREE.Vector3(...body.pole!))).toBeCloseTo(1, 9);
    expect(layer.bodies().every((b) => b.entityId.startsWith('body-'))).toBe(true);
    expect(layer.bodies().length).toBe(2);
  });
});

describe('markers of bodies too small to see', () => {
  const mat = new THREE.PointsMaterial();
  const { scene, layer } = layerOf(['EARTH', 'MARS', 'JUPITER', 'IO'], mat);
  const points = () => scene.children.find((o) => o instanceof THREE.Points) as THREE.Points;
  const sizes = () => Array.from(points().geometry.getAttribute('aSize').array as Float32Array);
  const idx = (id: string) => layer.bodies().findIndex((b) => b.entityId === `body-${id}`);

  it('are drawn through the shared point material, as exempt, ring glyphs with the body style colour', () => {
    expect(points().material).toBe(mat);
    const g = points().geometry;
    expect(Array.from(g.getAttribute('aShow').array)).toEqual(new Array(4).fill(2));
    expect(Array.from(g.getAttribute('aGlyph').array)).toEqual(new Array(4).fill(2));
    const j = idx('jupiter');
    const col = Array.from((g.getAttribute('aColor').array as Float32Array).slice(j * 3, j * 3 + 3));
    const base = hexRgb(BODY_STYLES.JUPITER.color);
    for (let k = 0; k < 3; k++) expect(col[k]).toBeGreaterThanOrEqual(base[k]);
  });

  it('show for a body whose disc is under the threshold, sit on its sight line, and hide when it is large', () => {
    // far: 1e9 km from Jupiter
    const jp = refPositionEci('JUPITER', T0);
    const far = new THREE.Vector3(jp[0] + 1e9, jp[1], jp[2]);
    layer.update(T0, far);
    layer.updateMarkers(45, 700);
    const j = idx('jupiter');
    expect(sizes()[j]).toBe(MARKER_SIZE_PX);
    const p = points().geometry.getAttribute('position');
    const rel = layer.bodies()[j].rel;
    const dist = Math.hypot(...rel);
    const mp: V3 = [p.getX(j), p.getY(j), p.getZ(j)];
    expect(Math.hypot(...mp)).toBeLessThan(dist);
    // same direction as the body (cross product ~ 0)
    const cr = Math.hypot(mp[1] * rel[2] - mp[2] * rel[1], mp[2] * rel[0] - mp[0] * rel[2], mp[0] * rel[1] - mp[1] * rel[0]);
    expect(cr / (Math.hypot(...mp) * dist)).toBeLessThan(1e-6);
    // close to Jupiter: a big disc, no marker
    layer.update(T0, new THREE.Vector3(jp[0] + 3e5, jp[1], jp[2]));
    layer.updateMarkers(45, 700);
    expect(sizes()[j]).toBe(0);
    // MARKER_BELOW_PX is the documented threshold
    expect(MARKER_BELOW_PX).toBe(2.5);
  });

  it('do not allocate: the attribute arrays are the same objects every frame', () => {
    const a = points().geometry.getAttribute('position').array, s = points().geometry.getAttribute('aSize').array;
    layer.update(T0 + 1000, new THREE.Vector3(1e8, 0, 0));
    layer.updateMarkers(45, 700);
    expect(points().geometry.getAttribute('position').array).toBe(a);
    expect(points().geometry.getAttribute('aSize').array).toBe(s);
  });

  it('are absent without a point material (tests and tools without a GPU)', () => {
    const { scene: s2 } = layerOf(['JUPITER']);
    expect(s2.children.some((o) => o instanceof THREE.Points)).toBe(false);
  });
});
