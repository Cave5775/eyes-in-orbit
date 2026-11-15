import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bodyEntityRecords, defaultBodies } from '@eio/core';
import { AssetCache } from '../src/lib/asset-cache';
import type { BodyShape } from '../src/lib/body-shape';
import { refPositionEci, refRadiusKm } from '../src/lib/ref-body';
import { CelestialLayer } from '../src/scene/celestial';
import { disposeScene, parseGlb, type LoadedGlb } from '../src/scene/models/glb';
import { triangleGlb } from './glb-fixture';

const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
const FOV = 50, VP = 700;

function layerOf(shapes: Record<string, BodyShape>, meshes?: AssetCache<LoadedGlb>) {
  const scene = new THREE.Scene();
  const layer = new CelestialLayer(scene, new THREE.Vector3(1, 0, 0), { loadTexture: () => undefined, shapes, meshes });
  layer.setBodies(bodyEntityRecords().filter((rec) => ['MARS', 'IO'].includes(rec.id.replace('body-', '').toUpperCase())));
  return { scene, layer };
}

/** An origin `km` from the body along +x, so its disc radius is a known size on screen. */
const camera = (id: string, km: number) => new THREE.Vector3(...refPositionEci(id, T0)).add(new THREE.Vector3(km, 0, 0));

const sphereOf = (scene: THREE.Scene, radius: number) =>
  scene.children.find((o) => (o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.type === 'SphereGeometry' && Math.abs(((o as THREE.Mesh).geometry as THREE.SphereGeometry).parameters.radius - radius) < 1e-6) as THREE.Mesh;

describe('tier 2: a triaxial ellipsoid from a sourced shape', () => {
  const io = refRadiusKm('IO');
  const shapes: Record<string, BodyShape> = { IO: { kind: 'ellipsoid', radiiKm: [io * 1.2, io, io * 0.8], source: 'test' } };

  it('scales the shared sphere per axis, with no extra geometry', () => {
    const { scene, layer } = layerOf(shapes);
    layer.update(T0, camera('IO', 5000));
    const m = sphereOf(scene, io);
    expect(m.scale.toArray()).toEqual([1.2, 1, 0.8].map((v) => expect.closeTo(v, 12)));
  });

  it('a body with no entry keeps its registry flattening (Mars: none drawn, so a unit scale)', () => {
    const { scene, layer } = layerOf(shapes);
    layer.update(T0, camera('MARS', 9000));
    const mars = sphereOf(scene, defaultBodies.get('MARS').radiusKm);
    expect(mars.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('invalid radii fall back to the sphere instead of drawing a degenerate mesh', () => {
    const { scene, layer } = layerOf({ IO: { kind: 'ellipsoid', radiiKm: [io, 0, io], source: 'test' } });
    layer.update(T0, camera('IO', 5000));
    expect(sphereOf(scene, io).scale.toArray()).toEqual([1, 1, 1]);
  });
});

describe('the shipped shapes (NAIF radii)', () => {
  it('Phobos is drawn as its triaxial ellipsoid, with the shader normal corrected per axis', () => {
    const scene = new THREE.Scene();
    const layer = new CelestialLayer(scene, new THREE.Vector3(1, 0, 0), { loadTexture: () => undefined });
    layer.setBodies(bodyEntityRecords().filter((r) => r.id === 'body-phobos'));
    layer.update(T0, camera('PHOBOS', 200));
    const mean = refRadiusKm('PHOBOS');
    const m = sphereOf(scene, mean);
    const want = [13.0 / mean, 11.4 / mean, 9.1 / mean];
    m.scale.toArray().forEach((v, i) => expect(v).toBeCloseTo(want[i], 12));
    const inv2 = (m.material as THREE.ShaderMaterial).uniforms.uInv2.value as THREE.Vector3;
    inv2.toArray().forEach((v, i) => expect(v).toBeCloseTo(1 / (want[i] * want[i]), 12));
  });
  it('a sphere keeps a neutral normal correction and an oblate giant corrects z only', () => {
    const scene = new THREE.Scene();
    const layer = new CelestialLayer(scene, new THREE.Vector3(1, 0, 0), { loadTexture: () => undefined });
    layer.setBodies(bodyEntityRecords().filter((r) => ['body-io', 'body-saturn'].includes(r.id)));
    layer.update(T0, camera('IO', 5000));
    const io = sphereOf(scene, refRadiusKm('IO'));
    expect(((io.material as THREE.ShaderMaterial).uniforms.uInv2.value as THREE.Vector3).toArray()).toEqual([1, 1, 1]);
    const sat = sphereOf(scene, refRadiusKm('SATURN'));
    const [x, y, z] = ((sat.material as THREE.ShaderMaterial).uniforms.uInv2.value as THREE.Vector3).toArray();
    expect([x, y]).toEqual([1, 1]);
    expect(z).toBeGreaterThan(1);
  });
});

describe('tier 3: a glb mesh, loaded only while the body is big on screen', () => {
  const io = refRadiusKm('IO');
  const url = '/models/io-test.glb';
  const make = () => {
    let loads = 0;
    const meshes = new AssetCache<LoadedGlb>({
      loader: async () => (loads++, parseGlb(triangleGlb())),
      dispose: (v) => disposeScene(v.scene),
      budgetBytes: 1e9,
    });
    const shapes: Record<string, BodyShape> = { IO: { kind: 'mesh', url, bytes: 36, loadPx: 24, source: 'test' } };
    const { scene, layer } = layerOf(shapes, meshes);
    return { scene, layer, meshes, loads: () => loads };
  };
  // wait until the cache has finished loading `url` (the first load also imports the glTF loader, which is slow under a loaded machine)
  const settle = async (meshes: AssetCache<LoadedGlb>) => {
    for (let i = 0; i < 600; i++) {
      await new Promise((r) => setTimeout(r, 5));
      if (meshes.stateOf(url) !== 'loading') return;
    }
  };
  // a disc radius px at distance d: tan(half-angle) = r / sqrt(d^2 - r^2) ~ r / d; focal = VP / (2 tan(fov/2))
  const distForPx = (px: number) => io / (px / (VP / (2 * Math.tan((FOV * Math.PI) / 360))));

  it('requests nothing while the body is small, loads when approached, swaps the sphere for the model, and drops it on leaving', async () => {
    const { scene, layer, meshes, loads } = make();
    const far = camera('IO', distForPx(5));
    layer.update(T0, far);
    layer.updateMeshes(FOV, VP);
    await settle(meshes);
    expect(loads()).toBe(0);
    expect(sphereOf(scene, io).visible).toBe(true);

    const near = camera('IO', distForPx(60));
    layer.update(T0, near);
    layer.updateMeshes(FOV, VP);
    await settle(meshes);
    expect(loads()).toBe(1);
    expect(meshes.peek(url)).not.toBeNull();
    layer.update(T0, near); // place() moves the model with the body
    expect(sphereOf(scene, io).visible).toBe(false);
    const group = scene.children.find((o) => o.type === 'Group') as THREE.Group;
    expect(group).toBeDefined();
    expect(group.scale.x).toBeCloseTo(io, 6); // the glb is normalised to radius 1, drawn at the body's mean radius
    expect(scene.children.some((o) => o.type === 'DirectionalLight')).toBe(true);

    // hysteresis: a smaller disc (still over 40% of the load radius) keeps it
    layer.update(T0, camera('IO', distForPx(14)));
    layer.updateMeshes(FOV, VP);
    expect(sphereOf(scene, io).visible).toBe(false);
    // far away again: back to the sphere, the model leaves the scene but the cache may keep the parsed file
    layer.update(T0, far);
    layer.updateMeshes(FOV, VP);
    expect(sphereOf(scene, io).visible).toBe(true);
    expect(scene.children.some((o) => o.type === 'Group')).toBe(false);
    expect(scene.children.some((o) => o.type === 'DirectionalLight')).toBe(false);
    // approaching again reuses the parsed file: no second load
    layer.update(T0, near);
    layer.updateMeshes(FOV, VP);
    await settle(meshes);
    expect(loads()).toBe(1);
    expect(scene.children.some((o) => o.type === 'Group')).toBe(true);
  });

  it('keeps the sphere when the file cannot be loaded', async () => {
    const meshes = new AssetCache<LoadedGlb>({ loader: async () => { throw new Error('404'); }, dispose: () => undefined, budgetBytes: 1 });
    const { scene, layer } = layerOf({ IO: { kind: 'mesh', url, bytes: 1, source: 'test' } }, meshes);
    const quiet = console.info;
    console.info = () => undefined;
    try {
      layer.update(T0, camera('IO', distForPx(60)));
      layer.updateMeshes(FOV, VP);
      await settle(meshes);
      expect(sphereOf(scene, io).visible).toBe(true);
      expect(scene.children.some((o) => o.type === 'Group')).toBe(false);
    } finally {
      console.info = quiet;
    }
  });

  it('removing the body releases its mesh', async () => {
    const { layer, meshes } = make();
    layer.update(T0, camera('IO', distForPx(60)));
    layer.updateMeshes(FOV, VP);
    await settle(meshes);
    layer.setBodies([]); // the body entities left the catalogue
    // released (idle) but still cached: a budget of 1e9 keeps it; acquiring now must not need a load
    expect(meshes.acquire(url).value).not.toBeNull();
  });
});
